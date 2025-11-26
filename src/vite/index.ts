import type { Plugin } from 'vite'

import { Buffer } from 'node:buffer'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { ofetch } from 'ofetch'
import { createLogger } from 'vite'

import { exists } from '../utils'

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
  },
): Plugin {
  return {
    name: `unplugin-fetch-${filename}`,
    async configResolved(config) {
      let { cacheDir, parentDir } = options || { cacheDir: '.cache', parentDir: config.publicDir }

      if (parentDir === false) {
        parentDir = undefined
      }

      const logger = createLogger()

      cacheDir = resolve(join(config.root, cacheDir))
      if (parentDir !== false) {
        parentDir = resolve(join(config.root, parentDir))
      }

      try {
        // cache
        if (await exists(resolve(join(cacheDir, destination, filename)))) {
          return
        }

        logger.info(`Downloading ${filename}...`)
        const stream = await ofetch(url, { responseType: 'arrayBuffer' })
        await mkdir(join(cacheDir, destination), { recursive: true })
        await writeFile(join(cacheDir, destination, filename), Buffer.from(stream))

        logger.info(`${filename} downloaded.`)

        if (await exists(resolve(join(parentDir as string, destination, filename)))) {
          return
        }

        await mkdir(join(parentDir as string, destination), { recursive: true }).catch(() => { })
        await copyFile(join(cacheDir, destination, filename), join(parentDir as string, destination, filename))
      }
      catch (err) {
        console.error(err)
        throw err
      }
    },
  }
}
