import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { createServer as createViteServer } from 'vite-plus'
import type { ViteDevServer } from 'vite-plus'
import { createApi, createStandbyApi, Events } from './api.ts'
import { loadExtensions } from './extensions.ts'
import type { Watch } from './extensions.ts'
import { prepareHarness } from './harness.ts'
import type { HostOptions, OpenHost } from './harness.ts'
import { createSystem } from './system.ts'
import type { ChildMessage, SupervisorMessage } from './supervisor-protocol.ts'

import { alive } from './lock.ts'
import { homedir } from 'node:os'
import { readFile, realpath, rm } from 'node:fs/promises'
import { extensionModules } from './vite-extensions.ts'
import { admit, createAccess } from './request-security.ts'
import { atomicJson, writeProject } from './project.ts'
import { reportCore } from './supervisor-protocol.ts'
import { viteLogger } from './vite-logger.ts'
import type { Notice } from '../shared/protocol.ts'
import type { JsonObject } from '@earendil-works/pi-durable'

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
  const notice = (entry: Notice) => {
    events.emit('notice', entry)
    reportCore({
      type: 'log',
      level: entry.level === 'warning' ? 'warn' : entry.level,
      source: 'core',
      text: entry.message,
    })
  }
  const host = await prepareHarness({
    ...options,
    ultimateRoot,
    projectRoot,
    report: notice,
  })
  let system: Awaited<ReturnType<typeof createSystem>> | undefined
  const access = createAccess(() => {
    void system?.changed()
  })
  let api: Awaited<ReturnType<typeof createApi>> | undefined
  const http = createHttpServer((request, response) => {
    void (async () => {
      const port =
        new URL(
          options.publicUrl ??
            `http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}`,
        ).port || '80'
      if (!(await admit(request, port, access.rules))) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      const serving = api ?? (processInfo.standby ? standbyApi : undefined)
      if (!serving) {
        response.writeHead(503)
        response.end('Preparing')
        return
      }
      if (await serving.handle(request, response)) return
      vite.middlewares(request, response)
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end('Internal server error')
    })
  })
  const hmr = createHttpServer()
  http.on('upgrade', (request, socket, head) => {
    const port =
      new URL(
        options.publicUrl ??
          `http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}`,
      ).port || '80'
    void admit(request, port, access.rules)
      .then((allowed) => {
        if (allowed) hmr.emit('upgrade', request, socket, head)
        else socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      })
      .catch(() => socket.destroy())
  })
  // A vite.config.ts change restarts Vite with a new watcher; listeners move to each new one.
  const restarted = new Set<(watcher: ViteDevServer['watcher']) => void>()
  reportCore({ type: 'web', state: 'preparing' })
  const vite = await createViteServer({
    customLogger: viteLogger(),
    clearScreen: false,
    configFile: resolvePath(ultimateRoot, 'vite.config.ts'),
    root: resolvePath(ultimateRoot, 'web'),
    server: {
      middlewareMode: true,
      allowedHosts: true,
      hmr: { server: hmr },
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
  let opened: OpenHost | undefined
  /** `standby` is the parsed `standby.json` while the server runs without storage. */
  const processInfo: { activationError?: string; standby?: JsonObject } = {}
  const standbyFile = join(host.home, 'standby.json')
  // go, release, activate and deactivate each finish before the next starts.
  let switching = Promise.resolve()
  const serial = <T>(task: () => Promise<T>) => {
    const next = switching.then(task)
    // The caller gets the failure; the queue only waits for the task to settle.
    switching = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const extensions = await loadExtensions(
    vite,
    host,
    () => system?.changed(),
    {
      access,
      harness: () => {
        if (!opened) throw new Error('Harness is not open')
        return opened.harness
      },
      system: () => {
        if (!system) throw new Error('System is not ready')
        return system.current()
      },
      conversations: () => api?.conversations() ?? [],
      standby: () => processInfo.standby,
      deactivate: (info, park) => serial(() => deactivate(info, park)),
      activate: (install) => serial(() => activate(install)),
    },
    watch,
    (message) => notice({ level: 'warning', message }),
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
    (message) => notice({ level: 'error', message }),
    processInfo,
    access.origins,
  )
  const standbyApi = createStandbyApi(events, system, extensions, access, () => processInfo.standby)
  const readStandby = async () => {
    let text: string
    try {
      text = await readFile(standbyFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const info: unknown = JSON.parse(text)
    if (!info || typeof info !== 'object' || Array.isArray(info))
      throw new Error(`${standbyFile} must hold a JSON object`)
    return info as JsonObject
  }
  /** Serve the opened harness: the `onOpen` callbacks, then the API, which replaces standby's. */
  const serve = async (harness: OpenHost) => {
    opened = harness
    await extensions.opened()
    processInfo.standby = undefined
    await system.changed()
    api = await createApi(host, harness, events, system, extensions, access)
    standbyApi.close()
    harness.harness.resume()
    return { ...harness, api, system }
  }
  const deactivate = async (info: JsonObject, park?: (database: string) => Promise<void>) => {
    if (processInfo.standby || !opened) return
    await extensions.released()
    await api?.close()
    api = undefined
    await opened.close()
    opened = undefined
    await atomicJson(standbyFile, JSON.stringify(info))
    processInfo.standby = info
    await system.changed()
    try {
      await park?.(host.database)
    } catch (error) {
      notice({ level: 'error', message: `Parking the database failed: ${String(error)}` })
      throw error
    } finally {
      // Persistence as parking left it.
      await system.changed()
    }
  }
  const activate = async (install?: (database: string) => Promise<void>) => {
    const info = processInfo.standby
    if (!info) return
    await install?.(host.database)
    await rm(standbyFile)
    // Until it opens, the server stays on standby, on disk too.
    const harness = await host.open(false).catch(async (error: unknown) => {
      await atomicJson(standbyFile, JSON.stringify(info))
      throw error
    })
    await serve(harness)
  }
  return {
    http,
    vite,
    host,
    extensions,
    events,
    url,
    port: address.port,
    release: () =>
      serial(async () => {
        if (opened) await extensions.released()
        await api?.close()
        api = undefined
        processInfo.standby = undefined
        standbyApi.close()
        http.closeAllConnections()
        await opened?.close()
        opened = undefined
        reportCore({ type: 'web', state: 'stopped' })
      }),
    /** Open storage and serve; with a `standby.json` in the home, serve standby instead and return undefined. */
    go: (activationError?: string) =>
      serial(async () => {
        processInfo.activationError = activationError
        await writeProject(host.home, host.projectRoot)
        const info = await readStandby()
        if (info) {
          processInfo.standby = info
          await system.changed()
          reportCore({ type: 'web', state: 'ready' })
          return undefined
        }
        const served = await serve(await host.open(false))
        reportCore({ type: 'web', state: 'ready' })
        return served
      }),
    async close() {
      const stopped = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
      await api?.close()
      standbyApi.close()
      await extensions.close()
      await system?.close()
      await vite.close()
      reportCore({ type: 'web', state: 'stopped' })
      http.closeAllConnections()
      await stopped
      await opened?.close()
    },
  }
}
export async function createServer(options: Partial<ServerOptions> = {}) {
  const prepared = await prepareServer(options)
  const opened = await prepared.go()
  if (!opened) throw new Error(`${prepared.host.home} is on standby`)
  return { ...prepared, ...opened, close: () => prepared.close() }
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
