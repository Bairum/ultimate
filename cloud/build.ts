import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'vite-plus'
import { extensionModules } from '../server/vite-extensions.ts'

// Vite keeps an inherited NODE_ENV, and a development one bundles development React; deploys always ship production.
process.env.NODE_ENV = 'production'
const root = fileURLToPath(new URL('../', import.meta.url))
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url))
const alias = { '@': fileURLToPath(new URL('../web/src', import.meta.url)) }
const [projectRoot = root, output, userHome = homedir()] = process.argv.slice(2)
const projectBuild = !!output
const outDir = output ?? fileURLToPath(new URL('./dist', import.meta.url))
await build({
  configFile,
  root: fileURLToPath(new URL('../web', import.meta.url)),
  resolve: { alias },
  base: projectBuild ? '/b/shared/' : '/',
  publicDir: projectBuild ? false : undefined,
  plugins: [extensionModules(root, projectRoot, userHome)],
  build: { outDir, emptyOutDir: true },
})
// The front page, a second entry with the app's styles and primitives; the Worker serves it at `/`.
if (!projectBuild)
  await build({
    configFile,
    root: fileURLToPath(new URL('./front', import.meta.url)),
    base: '/front/',
    publicDir: false,
    resolve: { alias },
    build: { outDir: `${outDir}/front`, emptyOutDir: false },
  })
