import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'vite-plus'
import { extensionModules } from '../server/vite-extensions.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url))
const alias = { '@': fileURLToPath(new URL('../web/src', import.meta.url)) }
const outDir = fileURLToPath(new URL('./dist', import.meta.url))
await build({
  configFile,
  root: fileURLToPath(new URL('../web', import.meta.url)),
  resolve: { alias },
  plugins: [extensionModules(root, root, homedir())],
  build: { outDir, emptyOutDir: true },
})
// The front page, a second entry with the app's styles and primitives; the Worker serves it at `/`.
await build({
  configFile,
  root: fileURLToPath(new URL('./front', import.meta.url)),
  base: '/front/',
  publicDir: false,
  resolve: { alias },
  build: { outDir: `${outDir}/front`, emptyOutDir: false },
})
