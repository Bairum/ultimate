import type {
  R2Bucket,
  DurableObjectNamespace,
  DurableObjectState,
  Fetcher,
  WebSocket as MachineSocket,
  WebSocketPair as MachineSocketPair,
} from '@cloudflare/workers-types'
import { ReplicaStore, proxyRequest, admitsRequest } from './replica.ts'
import { admitsAccess } from './access.ts'
import type { AccessConfig } from './access.ts'

import type { Sql } from './replica.ts'
import { PROJECT_MISMATCH } from './protocol.ts'
import type { MachineMessage } from './protocol.ts'
import { BUILD_ID, buildKey, contentType, uploadBuild, validName } from './builds.ts'
import { DirectoryStore } from './directory.ts'
import type { Instance, Presence } from './directory.ts'

// Workers provides this constructor; Node-side request tests do not use WebSocket upgrades.
declare const WebSocketPair: typeof MachineSocketPair

interface Env extends AccessConfig {
  BUILDS: R2Bucket
  VERSION?: WorkerVersionMetadata
  REPLICA: DurableObjectNamespace
  ASSETS: Fetcher
  DIRECTORY: DurableObjectNamespace
  TUNNELS?: string
  [binding: `TUNNEL_${number}`]: Fetcher | undefined
  MACHINE_ORIGIN?: string
  SYNC_TOKEN: string
}

// Drain rejected bodies without retaining them before returning across the Worker/DO boundary.
async function discardBody(request: Request) {
  if (!request.body) return
  const reader = request.body.getReader()
  try {
    while (!(await reader.read()).done) {
      // Discard each chunk; the forwarding stream must finish before the response is sent.
    }
  } finally {
    reader.releaseLock()
  }
}

function matchesSyncToken(authorization: string | null, token: string): boolean {
  if (!authorization) return false
  const encoder = new TextEncoder()
  const actual = encoder.encode(authorization)
  const expected = encoder.encode(`Bearer ${token}`)
  return (
    actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected)
  )
}

export default {
  async fetch(request: Request, env: Env) {
    const response = await route(request, env)
    // Open tabs compare this with the version they loaded to offer a reload after a deploy (web/src/sdk/store.ts).
    // A WebSocket upgrade keeps its own response.
    if (!env.VERSION || response.webSocket) return response
    const versioned = new Response(response.body, response)
    versioned.headers.set(
      'x-ultimate-cloud-version',
      response.headers.get('x-ultimate-cloud-version') ?? env.VERSION.id,
    )
    return versioned
  },
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const prefix = /^\/p\/([^/]+\/[^/]+)(?=\/|$)/.exec(url.pathname)
  const path = prefix ? url.pathname.slice(prefix[0].length) : url.pathname
  const api = path === '/api' || path.startsWith('/api/')
  if ((api || prefix || url.pathname.startsWith('/b/')) && !(await admitsAccess(request, env)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (url.pathname.startsWith('/sync/builds/')) {
    if (!env.SYNC_TOKEN || !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const [, id, name] = /^\/sync\/builds\/([^/]+)(?:\/(.+))?$/.exec(url.pathname) ?? []
    return uploadBuild(request, env.BUILDS, id ?? '', name)
  }
  if (url.pathname.startsWith('/b/')) {
    const [, id, name = 'index.html'] = /^\/b\/([^/]+)\/(.*)?$/.exec(url.pathname) ?? []
    if (!id || (id !== 'shared' && !BUILD_ID.test(id)))
      return new Response('Not found', { status: 404 })
    if (!validName(name)) return new Response('Not found', { status: 404 })
    const object = await env.BUILDS.get(buildKey(id, name))
    return object
      ? new Response(object.body, {
          headers: {
            'content-type': contentType(name),
            'cache-control':
              name === 'index.html' ? 'no-cache' : 'private, max-age=31536000, immutable',
          },
        })
      : new Response('Not found', { status: 404 })
  }
  // The front page is a static shell built by cloud/build.ts; its data comes from /api/directory behind Access.
  if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/front/', url), request))
  if (url.pathname === '/api/directory') return directory(env).fetch('https://directory/list')
  if (path === '/sync' && !prefix) {
    if (!env.SYNC_TOKEN || !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const machine = url.searchParams.get('machine'),
      project = url.searchParams.get('project')
    if (!machine || !project?.startsWith('/'))
      return Response.json({ error: 'Expected machine and absolute project' }, { status: 400 })
    return env.REPLICA.get(env.REPLICA.idFromName(JSON.stringify([machine, project]))).fetch(
      request,
    )
  }
  if (api || prefix) {
    if (!prefix) return Response.json({ error: 'Unknown project' }, { status: 404 })
    const resolved = await directory(env).fetch(
      `https://directory/resolve?slug=${encodeURIComponent(prefix[1])}`,
    )
    if (!resolved.ok) return resolved
    const instance: Instance = await resolved.json()
    const version = env.VERSION
      ? `${env.VERSION.id}${instance.uiBuild ? ':' + instance.uiBuild : ''}`
      : undefined
    let response: Response
    if (!api) {
      const object =
        instance.uiBuild && (await env.BUILDS.get(buildKey(instance.uiBuild, 'index.html')))
      response = object
        ? new Response(object.body, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
          })
        : await env.ASSETS.fetch(request)
    } else {
      url.pathname = path
      response = await env.REPLICA.get(
        env.REPLICA.idFromName(JSON.stringify([instance.machine, instance.project])),
      ).fetch(new Request(url, request))
    }
    if (version) {
      response = new Response(response.body, response)
      response.headers.set('x-ultimate-cloud-version', version)
    }
    return response
  }
  return env.ASSETS.fetch(request)
}

function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))
}

export class Directory {
  readonly store: DirectoryStore
  constructor(ctx: DurableObjectState) {
    this.store = new DirectoryStore({
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (run) => ctx.storage.transactionSync(run),
    } as Sql)
  }
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (request.method === 'POST') {
      const presence: Presence = await request.json()
      this.store.update(presence)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/list') return Response.json(this.store.list())
    const value = this.store.resolve(url.searchParams.get('slug') ?? '')
    return value
      ? Response.json(value)
      : Response.json({ error: 'Unknown project' }, { status: 404 })
  }
}

export class ProjectReplica {
  readonly ctx: DurableObjectState
  readonly env: Env
  readonly store: ReplicaStore
  readonly streams = new Set<{
    id: number
    send(name: string, value: unknown): void
    close(): void
  }>()
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
    this.store = new ReplicaStore({
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (run) => ctx.storage.transactionSync(run),
    } as Sql)
    // Constructed with sockets still attached means the object was evicted while they stayed open:
    // the only observable sign of hibernation. It logs in the waking event's trace, so that event's
    // outcome shows whether admission survived. Counts and an object-id prefix only, no content.
    const attached = ctx.getWebSockets()
    if (attached.length)
      console.log(
        `Replica woke: object=${ctx.id.toString().slice(0, 8)} sockets=${attached.length} admitted=${attached.filter((socket) => socket.deserializeAttachment() === true).length}`,
      )
  }
  sockets() {
    return this.ctx
      .getWebSockets()
      .filter(
        (socket) => socket.readyState === WebSocket.OPEN && socket.deserializeAttachment() === true,
      )
  }
  presence(connected: boolean) {
    const identity = this.store.identity()
    if (!identity) return
    this.ctx.waitUntil(
      directory(this.env)
        .fetch('https://directory/update', {
          method: 'POST',
          body: JSON.stringify({
            ...identity,
            connected,
            lastSeen: Date.now(),
            count: this.store.summaryCount(),
            hasEntries: this.store.hasEntries(),
          }),
        })
        .then(() => {}),
    )
  }
  refresh() {
    for (const stream of this.streams) stream.send('view', this.store.view(stream.id))
  }
  webSocketMessage(socket: MachineSocket, raw: string | ArrayBuffer) {
    let type = 'unknown'
    try {
      if (socket.readyState !== WebSocket.OPEN || !this.ctx.getWebSockets().includes(socket)) return
      const message = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
      ) as MachineMessage
      // Only protocol labels may reach logs, never arbitrary input or exception text.
      if (
        ['hello', 'uiBuild', 'batch', 'summaries', 'system', 'models', 'delivered'].includes(
          message?.type,
        )
      )
        type = message.type
      if (message.type === 'hello') {
        const held = this.store.metadata(4) as string | undefined
        if (
          (message.uiBuild !== undefined && !BUILD_ID.test(message.uiBuild)) ||
          (held !== undefined && held !== message.project) ||
          this.store.key() !== JSON.stringify([message.machine, message.project]) ||
          !Number.isInteger(message.port) ||
          message.port < 1 ||
          message.port > 65535
        ) {
          let reason = ''
          const encoder = new TextEncoder()
          for (const character of held ?? 'Machine or project mismatch') {
            if (encoder.encode(reason + character).byteLength > 123) break
            reason += character
          }
          socket.close(PROJECT_MISMATCH, reason)
          return
        }
        this.store.claimProject(message.project)
        for (const previous of this.sockets())
          if (previous !== socket) previous.close(1000, 'Replaced by new machine connection')
        socket.serializeAttachment(true)
        for (const stream of this.streams) stream.close()
      } else if (socket.deserializeAttachment() !== true) return
      const hasEntries = this.store.hasEntries()
      const count = message.type === 'summaries' ? this.store.summaryCount() : undefined
      for (const reply of this.store.receive(message)) socket.send(JSON.stringify(reply))
      if (
        message.type === 'hello' ||
        message.type === 'uiBuild' ||
        (count !== undefined && count !== this.store.summaryCount()) ||
        (message.type === 'batch' && hasEntries !== this.store.hasEntries())
      )
        this.presence(true)
      if (message.type === 'delivered') this.refresh()
    } catch (error) {
      const bytes =
        typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength
      console.error(`Cloud sync WebSocket exception: type=${type} bytes=${bytes}`)
      throw error
    }
  }
  webSocketClose(socket: MachineSocket) {
    socket.close()
    if (
      socket.deserializeAttachment() === true &&
      !this.sockets().some((other) => other !== socket)
    )
      this.presence(false)
  }
  webSocketError(socket: MachineSocket) {
    socket.close(1011, 'Sync failed')
    this.webSocketClose(socket)
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/sync') {
      if (
        !this.env.SYNC_TOKEN ||
        !matchesSyncToken(request.headers.get('Authorization'), this.env.SYNC_TOKEN)
      )
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return new Response('Expected WebSocket', { status: 426 })
      const machine = url.searchParams.get('machine'),
        project = url.searchParams.get('project')
      if (!machine || !project?.startsWith('/') || !this.store.claimKey(machine, project))
        return Response.json({ error: 'Project mismatch' }, { status: 409 })
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server)
      const upgrade = { status: 101, webSocket: client }
      return new Response(null, upgrade)
    }
    if (!admitsRequest(request)) {
      await discardBody(request)
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    const identity = this.store.identity()
    const bindings = JSON.parse(this.env.TUNNELS ?? '{}') as Record<string, `TUNNEL_${number}`>
    const binding = identity && this.env[bindings[identity.machine]]
    if (
      this.sockets().length &&
      identity &&
      Number.isInteger(identity.port) &&
      identity.port >= 1 &&
      identity.port <= 65535 &&
      (binding || this.env.MACHINE_ORIGIN)
    ) {
      try {
        const origin = new URL(binding ? 'http://127.0.0.1' : this.env.MACHINE_ORIGIN!)
        origin.port = String(identity.port)
        const forwarded = proxyRequest(request.clone(), origin.origin)
        if (binding) return await binding.fetch(forwarded)
        return await fetch(forwarded)
      } catch {
        // A lost response may follow a committed write. Only reads can safely fall back to the replica.
        if (request.method !== 'GET') {
          await discardBody(request)
          return Response.json(
            { error: 'The machine did not answer; check before retrying' },
            { status: 502 },
          )
        }
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/events') return this.events(request, url)
    if (request.method === 'GET' && url.pathname === '/api/models')
      return Response.json(this.store.metadata(3) ?? { providers: [], models: [] })
    const history = /^\/api\/conversations\/(\d+)\/history$/.exec(url.pathname)
    if (request.method === 'GET' && history) {
      const id = Number(history[1]),
        before = Number(url.searchParams.get('before'))
      if (!Number.isSafeInteger(before) || before < 1)
        return Response.json(
          { error: 'Invalid history cursor or conversation id' },
          { status: 400 },
        )
      if (!this.store.conversation(id))
        return Response.json({ error: 'Unknown conversation' }, { status: 404 })
      return Response.json(this.store.history(id, before))
    }
    const submit = /^\/api\/conversations\/(\d+)\/submit$/.exec(url.pathname)
    if (request.method === 'POST' && submit) {
      let data: Record<string, unknown>
      try {
        data = await request.json()
      } catch {
        return Response.json({ error: 'Expected JSON' }, { status: 400 })
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        return Response.json({ error: 'Expected JSON object' }, { status: 400 })
      if (data.images !== undefined && (!Array.isArray(data.images) || data.images.length))
        return Response.json(
          { error: 'Images are unavailable while the machine is offline' },
          { status: 503 },
        )
      if (
        typeof data.text !== 'string' ||
        !data.text.trim() ||
        (data.whenBusy !== undefined && data.whenBusy !== 'steer' && data.whenBusy !== 'followUp')
      )
        return Response.json({ error: 'Expected text and valid whenBusy' }, { status: 400 })
      const { submissionId } = this.store.enqueue(Number(submit[1]), data.text, data.whenBusy)
      for (const socket of this.sockets())
        socket.send(JSON.stringify({ type: 'outbox', items: this.store.outbox() }))
      this.refresh()
      return Response.json({ submissionId }, { status: 202 })
    }
    // Drain unsupported request bodies before replying across the Worker/DO boundary. Cancelling leaves
    // Wrangler's forwarding stream reading after the response, which can turn an expected 503 into a 500.
    await discardBody(request)
    return Response.json({ error: 'The machine is offline', offline: true }, { status: 503 })
  }
  events(request: Request, url: URL) {
    const id = Number(url.searchParams.get('conversation') ?? this.store.root())
    const encoder = new TextEncoder()
    let stop: (() => void) | undefined
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (name: string, value: unknown) =>
          controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`))
        controller.enqueue(encoder.encode('retry: 500\n\n'))
        const system = this.store.metadata(2)
        if (!system) {
          send('notice', { level: 'warning', message: 'No machine has synced yet' })
        } else {
          send('system', { ...system, offline: true })
          send(
            'conversations',
            this.store.summaries().map((summary) => ({
              ...summary,
              busy: false,
            })),
          )
          send('view', this.store.view(id))
          send('ui', { value: this.store.doc(this.store.root(), 'ultimate.ui') ?? {} })
          send('tasks', { tasks: {} })
          for (const kind of new Set(
            (url.searchParams.get('docs') ?? '').split(',').filter(Boolean),
          ))
            send('doc', { kind, value: this.store.doc(id, kind) })
          send('notice', {
            level: 'warning',
            message: 'The machine is offline. This is the last synced state.',
          })
        }
        const timer = setInterval(
          () => controller.enqueue(encoder.encode(': heartbeat\n\n')),
          15000,
        )
        let closed = false
        const stream = {
          id,
          send,
          close: () => {
            if (closed) return
            closed = true
            clearInterval(timer)
            this.streams.delete(stream)
            request.signal.removeEventListener('abort', stream.close)
            if (!cancelled) controller.close()
          },
        }
        stop = stream.close
        this.streams.add(stream)
        request.signal.addEventListener('abort', stop, { once: true })
        if (request.signal.aborted) stream.close()
      },
      cancel: () => {
        cancelled = true
        stop?.()
      },
    })
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })
  }
}
