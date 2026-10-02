import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { createServer as createViteServer } from 'vite-plus'
import type { ViteDevServer } from 'vite-plus'
import { createApi, Events } from './api.ts'
import { loadExtensions } from './extensions.ts'
import type { Watch } from './extensions.ts'
import { prepareHarness } from './harness.ts'
import type { HostOptions, OpenHost } from './harness.ts'
import { createSystem } from './system.ts'
import type { ChildMessage, SupervisorMessage } from './supervisor-protocol.ts'

import { alive } from './lock.ts'
import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { extensionModules } from './vite-extensions.ts'
import { loopbackAuthority, loopbackOrigin } from './request-security.ts'

const send = (message: ChildMessage) => process.send?.(message)

export interface ServerOptions extends HostOptions {
  port?: number
  publicUrl?: string
}
export async function prepareServer(options: Partial<ServerOptions> = {}) {
  const ultimateRoot =
    options.ultimateRoot ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
  const projectRoot = await realpath(
    options.projectRoot ?? process.env.ULTIMATE_PROJECT ?? options.ultimateRoot ?? process.cwd(),
  )
  const events = new Events()
  const host = await prepareHarness({
    ...options,
    ultimateRoot,
    projectRoot,
    report: (notice) => events.emit('notice', notice),
  })
  let api: Awaited<ReturnType<typeof createApi>> | undefined
  const http = createHttpServer((request, response) => {
    void (async () => {
      const port =
        new URL(
          options.publicUrl ??
            `http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}`,
        ).port || '80'
      if (
        !loopbackAuthority(request.headers.host, port) ||
        (request.headers.origin && !loopbackOrigin(request.headers.origin, port))
      ) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
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
  // A vite.config.ts change restarts Vite with a new watcher; listeners move to each new one.
  const restarted = new Set<(watcher: ViteDevServer['watcher']) => void>()
  const vite = await createViteServer({
    configFile: resolvePath(ultimateRoot, 'vite.config.ts'),
    root: resolvePath(ultimateRoot, 'web'),
    server: {
      middlewareMode: true,
      hmr: { server: http },
      fs: {
        allow: [ultimateRoot, projectRoot, resolvePath(options.userHome ?? homedir(), '.ultimate')],
      },
    },
    appType: 'spa',
    // One dependency cache per state home, so tests and instances never re-optimize the live instance's page.
    cacheDir: resolvePath(host.home, 'vite'),
    resolve: { alias: { '@': resolvePath(ultimateRoot, 'web/src') } },
    plugins: [
      extensionModules(ultimateRoot, projectRoot, host.userHome),
      {
        name: 'ultimate:watchers',
        configureServer: (server) => {
          for (const move of restarted) move(server.watcher)
        },
      },
    ],
  })
  const watch: Watch = (attach) => {
    let detach = attach(vite.watcher)
    const move = (watcher: ViteDevServer['watcher']) => {
      detach()
      detach = attach(watcher)
    }
    restarted.add(move)
    return () => {
      restarted.delete(move)
      detach()
    }
  }
  let system: Awaited<ReturnType<typeof createSystem>> | undefined
  let opened: OpenHost | undefined
  const processInfo: { activationError?: string } = {}
  const extensions = await loadExtensions(
    vite,
    host,
    () => system?.changed(),
    {
      harness: () => {
        if (!opened) throw new Error('Harness is not open')
        return opened.harness
      },
      system: () => {
        if (!system) throw new Error('System is not ready')
        return system.current()
      },
    },
    watch,
    (message) => events.emit('notice', { level: 'warning', message }),
  )
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? Number(process.env.ULTIMATE_PORT ?? 4747), '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('No listening address')
  const url = options.publicUrl ?? `http://127.0.0.1:${address.port}`
  system = await createSystem(
    host,
    watch,
    url,
    extensions.info,
    (info) => events.emit('system', info),
    (message) => events.emit('notice', { level: 'error', message }),
    processInfo,
  )
  return {
    http,
    vite,
    host,
    extensions,
    events,
    url,
    port: address.port,
    async release() {
      extensions.released()
      await api?.close()
      api = undefined
      http.closeAllConnections()
      await opened?.close()
      opened = undefined
    },
    async go(activationError?: string) {
      processInfo.activationError = activationError
      opened = await host.open(false)
      await extensions.opened()
      await system.changed()
      api = await createApi(host, opened, events, system, extensions)
      opened.harness.resume()
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
  if (process.env.ULTIMATE_INSTANCE_OWNER) {
    const owner = Number(process.env.ULTIMATE_INSTANCE_OWNER)
    if (!Number.isSafeInteger(owner) || owner < 1) throw new Error('Invalid instance owner')
    setInterval(() => {
      if (!alive(owner)) process.exit(0)
    }, 500).unref()
  }
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
      server = await prepareServer({ port: 0, publicUrl: process.env.ULTIMATE_PUBLIC_URL })
      process.on('message', (message: SupervisorMessage) => {
        void (async () => {
          if (message.type === 'go' || message.type === 'reacquire') {
            await server!.go(message.type === 'reacquire' ? message.error : undefined)
            send({ type: 'ready' })
          }
          if (message.type === 'release') {
            await server!.release()
            send({ type: 'released' })
          }
          if (message.type === 'exit') {
            await close()
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
