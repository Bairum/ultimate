import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { createServer as createViteServer } from 'vite-plus'
import { createApi, Events } from './api.ts'
import { loadExtensions } from './extensions.ts'
import { prepareHarness } from './harness.ts'
import type { HostOptions, OpenHost } from './harness.ts'
import { createSystem } from './system.ts'
import type { ChildMessage, SupervisorMessage } from './supervisor-protocol.ts'

const send = (message: ChildMessage) => process.send?.(message)

export interface ServerOptions extends HostOptions {
  port?: number
}
export async function prepareServer(options: Partial<ServerOptions> = {}) {
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
      if (!api) {
        response.writeHead(503)
        response.end('Preparing')
        return
      }
      if (await api.handle(request, response)) return
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
  let opened: OpenHost | undefined
  const extensions = await loadExtensions(vite, host, () => system?.changed(), {
    harness: () => {
      if (!opened) throw new Error('Harness is not open')
      return opened.harness
    },
    system: () => {
      if (!system) throw new Error('System is not ready')
      return system.current()
    },
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? Number(process.env.ULTIMATE_PORT ?? 4747), '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('No listening address')
  const url = process.env.ULTIMATE_PUBLIC_URL ?? `http://127.0.0.1:${address.port}`
  system = await createSystem(host, vite, url, extensions.info, (info) =>
    events.emit('system', info),
  )
  return {
    http,
    vite,
    host,
    extensions,
    events,
    url,
    port: address.port,
    async go() {
      opened = await host.open()
      await system.changed()
      api = await createApi(host, opened, events, system, extensions)
      return { ...opened, api, system }
    },
    async close() {
      const stopped = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
      await api?.close()
      await extensions.close()
      await system?.close()
      await vite.close()
      http.closeAllConnections()
      await stopped
      await opened?.close()
    },
  }
}
export async function createServer(options: Partial<ServerOptions> = {}) {
  const prepared = await prepareServer(options)
  return { ...prepared, ...(await prepared.go()) }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let server: Awaited<ReturnType<typeof prepareServer>> | undefined
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await server?.close()
  }
  process.on('SIGINT', () => {
    void close().then(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    void close().then(() => process.exit(0))
  })
  if (process.env.ULTIMATE_SUPERVISED === '1' && process.send) {
    try {
      if (process.env.ULTIMATE_FAIL_PREPARE_GENERATION === process.env.ULTIMATE_GENERATION)
        throw new Error('Injected preparation failure')
      server = await prepareServer({ port: 0 })
      process.on('message', (message: SupervisorMessage) => {
        void (async () => {
          if (message.type === 'go') {
            await server!.go()
            send({ type: 'ready' })
          }
          if (message.type === 'release') {
            await close()
            send({ type: 'released' })
            process.disconnect?.()
            process.exit(0)
          }
        })().catch((error) => {
          send({ type: 'failed', error: String(error) })
          console.error(error)
          process.exit(1)
        })
      })
      process.on('disconnect', () => {
        void close().then(() => process.exit(0))
      })
      send({ type: 'prepared', port: server.port })
    } catch (error) {
      send({ type: 'failed', error: String(error) })
      console.error(error)
      process.exit(1)
    }
  } else {
    server = await prepareServer()
    await server.go()
    console.log(`Ultimate: ${server.url}`)
  }
}
