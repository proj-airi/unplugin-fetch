import type { Buffer } from 'node:buffer'

import type { Plugin, ResolvedConfig } from 'vite'

import process from 'node:process'

import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ofetch } from 'ofetch'

import { DownloadProgress, exists } from '../utils'

/**
 * Abort a download after this long without receiving a single byte.
 *
 * A deadline over the whole request would kill a large file on a slow link, so
 * only silence between chunks counts.
 */
const defaultIdleTimeoutMs = 30_000

interface DownloadTask {
  id: number
  filename: string
}

/**
 * All downloads of one Vite config share a single progress line.
 *
 * Vite runs `configResolved` through `Promise.all`, so the `Download()` plugins
 * of one config transfer concurrently, and reporting per file would interleave
 * their output.
 */
const progressByConfig = new WeakMap<ResolvedConfig, DownloadProgress>()

/**
 * Plugins are created while the config loads; keying the task by plugin lets
 * each hook find its own.
 */
const taskByPlugin = new WeakMap<Plugin, DownloadTask>()
let nextTaskId = 0

function progressFor(config: ResolvedConfig): DownloadProgress {
  const existing = progressByConfig.get(config)
  if (existing)
    return existing

  const tasks: DownloadTask[] = []
  for (const plugin of config.plugins) {
    const task = taskByPlugin.get(plugin)
    if (task)
      tasks.push(task)
  }

  const progress = new DownloadProgress({
    logger: config.logger,
    tasks,
    // A custom logger may not write to stdout at all, and silent mode asks for
    // no output: neither should get raw ANSI
    interactive: config.customLogger === undefined
      && config.logLevel !== 'silent'
      && process.stdout.isTTY === true
      && process.env.TERM !== 'dumb',
  })

  progressByConfig.set(config, progress)

  return progress
}

/**
 * Downloads one remote file into the cache.
 *
 * The body streams straight to disk, so a large file never sits in memory in
 * full. The download is written next to its final name and renamed only once it
 * completes. An interrupted download therefore leaves no file that the next run
 * would mistake for a cached one.
 *
 * Throws when the response has no body, the request fails, or the transfer stalls.
 */
async function downloadFile(options: {
  url: string
  filename: string
  path: string
  idleTimeoutMs: number
  progress: DownloadProgress
  taskId: number
}): Promise<number> {
  const { url, filename, path, idleTimeoutMs, progress, taskId } = options
  const startedAt = Date.now()
  const partialPath = `${path}.part`
  const controller = new AbortController()

  let idleTimer: NodeJS.Timeout | undefined
  const armIdleTimeout = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`no data received for ${idleTimeoutMs} ms`))
    }, idleTimeoutMs)
  }

  armIdleTimeout()

  try {
    const response = await ofetch.raw(url, { responseType: 'stream', signal: controller.signal })
    const body = response._data
    if (!body)
      throw new Error(`${filename}: the response carried no body`)

    // A server may omit this, or split the transfer with chunked encoding. The
    // transfer still works, it just runs without a percentage.
    const total = Number(response.headers.get('content-length') ?? 0)
    let received = 0

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        armIdleTimeout()
        received += chunk.length
        progress.update(taskId, received, total)

        callback(null, chunk)
      },
    })

    await pipeline(
      Readable.fromWeb(body),
      counter,
      createWriteStream(partialPath),
    )
    await rename(partialPath, path)

    progress.complete(taskId)
    progress.info(`${filename} downloaded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`)

    return received
  }
  catch (error) {
    await rm(partialPath, { force: true }).catch(() => { })

    if (controller.signal.aborted)
      throw new Error(`${filename}: download stalled, no data received for ${idleTimeoutMs} ms`)

    throw error
  }
  finally {
    clearTimeout(idleTimer)
  }
}

export function Download(
  url: string,
  filename: string,
  destination: string,
  options?: {
    /**
     * @default '.cache'
     */
    cacheDir?: string
    /**
     * @default 'public' or `config.publicDir`
     */
    parentDir?: false | string
    /**
     * Abort the download after this long without receiving a byte.
     *
     * @default 30000
     */
    idleTimeout?: number
  },
): Plugin {
  const task: DownloadTask = { id: nextTaskId, filename }
  nextTaskId += 1

  const plugin: Plugin = {
    name: `unplugin-fetch-${filename}`,
    async configResolved(config) {
      const progress = progressFor(config)

      const cacheDirOption = options?.cacheDir ?? '.cache'
      const parentDirOption = options?.parentDir ?? config.publicDir ?? config.root

      const cacheDir = isAbsolute(cacheDirOption) ? cacheDirOption : resolve(config.root, cacheDirOption)
      const parentDir = parentDirOption === false
        ? config.root
        : isAbsolute(parentDirOption)
          ? parentDirOption
          : resolve(config.root, parentDirOption)

      const cachePath = join(cacheDir, destination, filename)

      try {
        // cache
        if (await exists(resolve(cachePath))) {
          progress.skip(task.id)
          progress.info(`${filename} already exists in cache.`)
        }
        else {
          progress.info(`Downloading ${filename}...`)
          await mkdir(join(cacheDir, destination), { recursive: true })
          await downloadFile({
            url,
            filename,
            path: cachePath,
            idleTimeoutMs: options?.idleTimeout ?? defaultIdleTimeoutMs,
            progress,
            taskId: task.id,
          })
        }

        if (await exists(resolve(join(parentDir, destination, filename)))) {
          progress.info(`${filename} already exists in ${parentDir}.`)
          return
        }

        await mkdir(join(parentDir, destination), { recursive: true }).catch(() => { })
        await copyFile(cachePath, join(parentDir, destination, filename))
        progress.info(`${filename} copied to ${parentDir}.`)
      }
      catch (err) {
        // Erase the progress line it is holding first, or the error prints on top of it
        progress.stop()
        console.error(err)
        throw err
      }
    },
  }

  taskByPlugin.set(plugin, task)

  return plugin
}
