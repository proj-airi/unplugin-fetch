<a name="readme-top"></a>

# `@proj-airi/unplugin-fetch`

Helper plugin for helping installing the remote assets into public dir.

> [!NOTE]
>
> This project is part of (and also associate to) the [Project AIRI](https://github.com/moeru-ai/airi), we aim to build a LLM-driven VTuber like [Neuro-sama](https://www.youtube.com/@Neurosama) (subscribe if you didn't!) if you are interested in, please do give it a try on [live demo](https://airi.moeru.ai).

## Installation

Pick the package manager of your choice:

```shell
ni @proj-airi/unplugin-fetch -D # from @antfu/ni, can be installed via `npm i -g @antfu/ni`
pnpm i @proj-airi/unplugin-fetch -D
yarn i @proj-airi/unplugin-fetch -D
npm i @proj-airi/unplugin-fetch -D
```

### UnoCSS usage

```typescript
import { defineConfig } from 'vite'

import { Download } from '@proj-airi/unplugin-fetch/vite'

export default defineConfig({
  plugins: [
    Download('https://dist.ayaka.moe/live2d-models/hiyori_free_zh.zip', 'hiyori_free_zh.zip', 'assets/live2d/models'),
    Download('https://dist.ayaka.moe/live2d-models/hiyori_pro_zh.zip', 'hiyori_pro_zh.zip', 'assets/live2d/models'),
  ]
})
```

`cacheDir` and `parentDir` can be absolute paths if you want to share cache across packages (for example `const sharedCacheDir = resolve(join(import.meta.dirname, '..', '..', '.cache'))`). Absolute values are used as-is; relative values are resolved against `config.root`. When `parentDir: false`, assets are copied to `config.root/<destination>` instead of being skipped.

### Progress and timeout

On an interactive terminal every download of one config shares a single line,
rewritten in place, so a long transfer never looks stuck:

```text
Downloading preload.data...
Downloading hiyori_free_zh.zip...
0/2 files   43% ██████████░░░░░░░░░░░░░░░░░░  1.3 MiB / 3.0 MiB  1.3 MiB/s  ETA 0:01
hiyori_free_zh.zip downloaded in 1.5s.
hiyori_free_zh.zip copied to /path/to/public.
preload.data   84% ██████████████████████░░░  2.6 MiB / 3.0 MiB  1.1 MiB/s  ETA 0:01
preload.data downloaded in 3.1s.
preload.data copied to /path/to/public.
```

The percentage counts the bytes of every file still downloading plus the ones
that already finished, so one line covers the whole set even though the
downloads run concurrently. When a server sends no `content-length`, the bar is
replaced by a spinner and the received byte count. The line gives up detail
before it wraps: the ETA goes first, then the speed and the total size, and only
then is the file name shortened.

Terminals that implement the ConEmu/Windows Terminal progress sequence
(`OSC 9;4`) additionally show the same progress in the tab header and on the
taskbar, cleared once the downloads finish.

Output that is not a terminal — a pipe, CI, `--silent`, or a custom Vite logger
— gets one line per file per second instead:

```text
preload.data: 42% (95.1 MiB / 226.2 MiB)
```

`idleTimeout` aborts a download that stops sending data. It defaults to 30000
milliseconds. Only silence between chunks counts, so a slow link to a large file
is not treated as a failure. Raise it when a server pauses for long stretches:

```typescript
Download(url, 'preload.data', 'assets/models', { idleTimeout: 120_000 })
```

A download is written to `<filename>.part` and renamed when it completes. An
interrupted download therefore leaves no file that a later run would treat as
cached.

## Other side projects born from Project AIRI

- [Awesome AI VTuber](https://github.com/proj-airi/awesome-ai-vtuber): A curated list of AI VTubers and related projects
- [`unspeech`](https://github.com/moeru-ai/unspeech): Universal endpoint proxy server for `/audio/transcriptions` and `/audio/speech`, like LiteLLM but for any ASR and TTS
- [`hfup`](https://github.com/moeru-ai/hfup): tools to help on deploying, bundling to HuggingFace Spaces
- [`xsai-transformers`](https://github.com/moeru-ai/xsai-transformers): Experimental [🤗 Transformers.js](https://github.com/huggingface/transformers.js) provider for [xsAI](https://github.com/moeru-ai/xsai).
- [WebAI: Realtime Voice Chat](https://github.com/proj-airi/webai-realtime-voice-chat): Full example of implementing ChatGPT's realtime voice from scratch with VAD + STT + LLM + TTS.
- [`@proj-airi/drizzle-duckdb-wasm`](https://github.com/moeru-ai/airi/tree/main/packages/drizzle-duckdb-wasm/README.md): Drizzle ORM driver for DuckDB WASM
- [`@proj-airi/duckdb-wasm`](https://github.com/moeru-ai/airi/tree/main/packages/duckdb-wasm/README.md): Easy to use wrapper for `@duckdb/duckdb-wasm`
- [Airi Factorio](https://github.com/moeru-ai/airi-factorio): Allow Airi to play Factorio
- [Factorio RCON API](https://github.com/nekomeowww/factorio-rcon-api): RESTful API wrapper for Factorio headless server console
- [`autorio`](https://github.com/moeru-ai/airi-factorio/tree/main/packages/autorio): Factorio automation library
- [`tstl-plugin-reload-factorio-mod`](https://github.com/moeru-ai/airi-factorio/tree/main/packages/tstl-plugin-reload-factorio-mod): Reload Factorio mod when developing
- [Velin](https://github.com/luoling8192/velin): Use Vue SFC and Markdown to write easy to manage stateful prompts for LLM
- [`demodel`](https://github.com/moeru-ai/demodel): Easily boost the speed of pulling your models and datasets from various of inference runtimes.
- [`inventory`](https://github.com/moeru-ai/inventory): Centralized model catalog and default provider configurations backend service
- [MCP Launcher](https://github.com/moeru-ai/mcp-launcher): Easy to use MCP builder & launcher for all possible MCP servers, just like Ollama for models!
- [🥺 SAD](https://github.com/moeru-ai/sad): Documentation and notes for self-host and browser running LLMs.
