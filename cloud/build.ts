import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'vite-plus'
import { extensionModules } from '../server/vite-extensions.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  root: fileURLToPath(new URL('../web', import.meta.url)),
  resolve: { alias: { '@': fileURLToPath(new URL('../web/src', import.meta.url)) } },
  plugins: [extensionModules(root, root, homedir())],
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true },
})
