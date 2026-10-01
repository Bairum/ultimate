import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { createServer as createViteServer } from 'vite-plus'
import { createApi, Events } from './api.ts'
import { loadExtensions } from './extensions.ts'
import { prepareHarness } from './harness.ts'
import type { HostOptions } from './harness.ts'
import { createSystem } from './system.ts'

export interface ServerOptions extends HostOptions {
  port?: number
}
export async function createServer(options: Partial<ServerOptions> = {}) {
  const repoRoot = options.repoRoot ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
  const events = new Events()
  const host = await prepareHarness({
    ...options,
    repoRoot,
    report: (notice) => events.emit('notice', notice),
  })
  let api: Awaited<ReturnType<typeof createApi>> | undefined
  const http = createHttpServer((request, response) => {
    void (async () => {
      if (api && (await api.handle(request, response))) return
      vite.middlewares(request, response)
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end('Internal server error')
    })
  })
  const vite = await createViteServer({
    configFile: resolvePath(repoRoot, 'vite.config.ts'),
    root: resolvePath(repoRoot, 'web'),
    server: { middlewareMode: true, hmr: { server: http }, fs: { allow: [repoRoot] } },
    appType: 'spa',
  })
  let system: Awaited<ReturnType<typeof createSystem>> | undefined
  const extensions = await loadExtensions(vite, host, () => system?.changed())
  const opened = await host.open()
  const port = options.port ?? Number(process.env.ULTIMATE_PORT ?? 4747)
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('No listening address')
  const url = `http://127.0.0.1:${address.port}`
  system = await createSystem(host, vite, url, extensions.info, (info) =>
    events.emit('system', info),
  )
  api = await createApi(host, opened, events, system, extensions)
  return {
    http,
    vite,
    host,
    ...opened,
    api,
    system,
    extensions,
    events,
    url,
    async close() {
      await api.close()
      await extensions.close()
      await system.close()
      await vite.close()
      http.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
      await opened.close()
    },
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createServer()
  console.log(`Ultimate: ${server.url}`)
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
}
