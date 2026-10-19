import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'vite-plus'

// Vite keeps an inherited NODE_ENV, and a development one bundles development React; deploys always ship production.
process.env.NODE_ENV = 'production'
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url))
const alias = { '@': fileURLToPath(new URL('../web/src', import.meta.url)) }
const dist = fileURLToPath(new URL('./dist', import.meta.url))
// Everything in dist/ is deployed as assets: an older build's app must not linger next to the front page.
rmSync(dist, { recursive: true, force: true })
// The front page, with the app's styles and primitives; the Worker serves it at `/`.
await build({
  configFile,
  root: fileURLToPath(new URL('./front', import.meta.url)),
  base: '/front/',
  publicDir: fileURLToPath(new URL('../web/public', import.meta.url)),
  resolve: { alias },
  build: { outDir: `${dist}/front` },
})
