import type { Buffer } from 'node:buffer'

import type { Plugin } from 'vite'

import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ofetch } from 'ofetch'
import { createLogger } from 'vite'

import { exists } from '../utils'

/** A progress line is written at most once per this many milliseconds. */
const progressIntervalMs = 1000

/**
 * Abort a download after this long without receiving a single byte.
 *
 * A deadline over the whole request would kill a large file on a slow link, so
 * only silence between chunks counts.
 */
const defaultIdleTimeoutMs = 30_000

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`

  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(1)} ${units[unit]}`
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
  logger: ReturnType<typeof createLogger>
  idleTimeoutMs: number
}): Promise<number> {
  const { url, filename, path, logger, idleTimeoutMs } = options
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
    let lastReportAt = startedAt

    const reporter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        armIdleTimeout()
        received += chunk.length

        const now = Date.now()
        if (total > 0 && now - lastReportAt >= progressIntervalMs) {
          lastReportAt = now
          const percent = Math.min(100, Math.floor((received / total) * 100))
          logger.info(`${filename}: ${percent}% (${formatBytes(received)} / ${formatBytes(total)})`)
        }

        callback(null, chunk)
      },
    })

    await pipeline(
      Readable.fromWeb(body),
      reporter,
      createWriteStream(partialPath),
    )
    await rename(partialPath, path)
    logger.info(`${filename} downloaded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`)

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
  return {
    name: `unplugin-fetch-${filename}`,
    async configResolved(config) {
      const logger = createLogger()

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
          logger.info(`${filename} already exists in cache.`)
        }
        else {
          logger.info(`Downloading ${filename}...`)
          await mkdir(join(cacheDir, destination), { recursive: true })
          await downloadFile({
            url,
            filename,
            path: cachePath,
            logger,
            idleTimeoutMs: options?.idleTimeout ?? defaultIdleTimeoutMs,
          })
        }

        if (await exists(resolve(join(parentDir, destination, filename)))) {
          logger.info(`${filename} already exists in ${parentDir}.`)
          return
        }

        await mkdir(join(parentDir, destination), { recursive: true }).catch(() => { })
        await copyFile(cachePath, join(parentDir, destination, filename))
        logger.info(`${filename} copied to ${parentDir}.`)
      }
      catch (err) {
        console.error(err)
        throw err
      }
    },
  }
}
