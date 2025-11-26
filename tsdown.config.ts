import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'vite/index': 'src/vite/index.ts',
  },
  dts: true,
  sourcemap: true,
  unused: true,
})
