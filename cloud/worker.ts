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
import { PROJECT_KEY, PROJECT_MISMATCH } from './protocol.ts'
import type { CloudMessage, Hello, MachineMessage } from './protocol.ts'
import { BUILD_ID, buildKey, contentType, uploadBuild, validName } from './builds.ts'
import { DirectoryStore } from './directory.ts'
import { snapshotObject } from './snapshots.ts'
import type { Presence, Project } from './directory.ts'

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
  const prefix = /^\/p\/([^/]+)(?=\/|$)/.exec(url.pathname)
  const path = prefix ? url.pathname.slice(prefix[0].length) : url.pathname
  const api = path === '/api' || path.startsWith('/api/')
  if ((api || prefix || url.pathname.startsWith('/b/')) && !(await admitsAccess(request, env)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (url.pathname.startsWith('/sync/builds/') || url.pathname.startsWith('/sync/snapshots/')) {
    if (!env.SYNC_TOKEN || !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    if (url.pathname.startsWith('/sync/snapshots/')) {
      const [, project = '', id = '', name = ''] =
        /^\/sync\/snapshots\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname) ?? []
      return snapshotObject(request, env.BUILDS, project, id, name)
    }
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
  if (url.pathname === '/sync/v2') {
    if (!env.SYNC_TOKEN || !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const key = url.searchParams.get('project')
    if (!key || !PROJECT_KEY.test(key))
      return Response.json({ error: 'Expected a project key' }, { status: 400 })
    // A relinked key syncs to its target's replica, which admits hellos naming either key.
    const alias = await directory(env).fetch(
      `https://directory/alias?key=${encodeURIComponent(key)}`,
    )
    if (!alias.ok) return env.REPLICA.get(env.REPLICA.idFromName(key)).fetch(request)
    const { target }: { target: string } = await alias.json()
    url.searchParams.set('project', target)
    url.searchParams.set('alias', key)
    return env.REPLICA.get(env.REPLICA.idFromName(target)).fetch(new Request(url, request))
  }
  if (url.pathname === '/sync/relink') {
    if (!env.SYNC_TOKEN || !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    const body = (await request.json().catch(() => ({}))) as { key?: unknown; from?: unknown }
    const { key, from } = body ?? {}
    if (
      typeof key !== 'string' ||
      typeof from !== 'string' ||
      !PROJECT_KEY.test(key) ||
      !PROJECT_KEY.test(from) ||
      key === from
    )
      return Response.json({ error: 'Expected two different project keys' }, { status: 400 })
    return directory(env).fetch('https://directory/alias', {
      method: 'POST',
      body: JSON.stringify({ key, from }),
    })
  }
  if (url.pathname === '/sync' || url.pathname.startsWith('/sync/'))
    return Response.json({ error: 'Unknown sync endpoint' }, { status: 404 })
  if (api || prefix) {
    if (!prefix) return Response.json({ error: 'Unknown project' }, { status: 404 })
    const resolve = (slug: string) =>
      directory(env).fetch(`https://directory/resolve?slug=${encodeURIComponent(slug)}`)
    const resolved = await resolve(prefix[1])
    if (!resolved.ok) {
      // URLs were /p/<machine>/<project>/ before projects had one replica each.
      const [, name, rest] = /^\/([^/]+)(.*)$/.exec(path) ?? []
      if (!name || !(await resolve(name)).ok) return resolved
      return new Response(null, {
        status: 308,
        headers: { Location: `/p/${name}${rest}${url.search}` },
      })
    }
    const project: Project = await resolved.json()
    const version = env.VERSION
      ? `${env.VERSION.id}${project.uiBuild ? ':' + project.uiBuild : ''}`
      : undefined
    let response: Response
    if (!api) {
      const object =
        project.uiBuild && (await env.BUILDS.get(buildKey(project.uiBuild, 'index.html')))
      response = object
        ? new Response(object.body, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
          })
        : await env.ASSETS.fetch(request)
    } else {
      url.pathname = path
      response = await env.REPLICA.get(env.REPLICA.idFromName(project.key)).fetch(
        new Request(url, request),
      )
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

// Retired classes stay exported until a later deploy deletes them; nothing binds them (README "Deploy").
class Retired {
  fetch() {
    return new Response('Gone', { status: 410 })
  }
}
export class Directory extends Retired {}
export class ProjectReplica extends Retired {}

export class ProjectDirectory {
  readonly store: DirectoryStore
  constructor(ctx: DurableObjectState) {
    this.store = new DirectoryStore({
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (run) => ctx.storage.transactionSync(run),
    } as Sql)
  }
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/alias') {
      if (request.method === 'POST') {
        const { key, from }: { key: string; from: string } = await request.json()
        return this.store.alias(key, from)
          ? new Response(null, { status: 204 })
          : Response.json({ error: 'A project cannot alias itself' }, { status: 400 })
      }
      const target = this.store.target(url.searchParams.get('key') ?? '')
      return target
        ? Response.json({ target })
        : Response.json({ error: 'No alias' }, { status: 404 })
    }
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

/**
 * A socket's attachment: its project key from the URL (with the relinked key it connected with, if any), then the
 * machine and role its hello earned.
 */
interface Attachment {
  key: string
  alias?: string
  machine?: string
  role?: 'writer' | 'standby'
  /** This socket's checkout, from its hello: a claim takes the lease for it, not for another checkout of the machine. */
  checkout?: { root: string; port: number; secrets: string[] }
}
const attachment = (socket: MachineSocket) =>
  socket.deserializeAttachment() as Attachment | null | undefined

function validHello(hello: Hello, { key, alias }: Attachment) {
  return (
    (hello.key === key || hello.key === alias) &&
    typeof hello.rootCommit === 'string' &&
    /^[0-9a-f]{40,64}$/.test(hello.rootCommit) &&
    typeof hello.root === 'string' &&
    hello.root.startsWith('/') &&
    typeof hello.machine === 'string' &&
    hello.machine.length > 0 &&
    Number.isInteger(hello.port) &&
    hello.port >= 1 &&
    hello.port <= 65535 &&
    (hello.uiBuild === undefined || BUILD_ID.test(hello.uiBuild)) &&
    (hello.epoch === undefined || (Number.isSafeInteger(hello.epoch) && hello.epoch >= 1)) &&
    typeof hello.history === 'boolean' &&
    Array.isArray(hello.secrets) &&
    hello.secrets.every((name) => typeof name === 'string') &&
    (hello.transition === undefined ||
      (typeof hello.transition === 'string' && /^[\w-]{1,64}$/.test(hello.transition)))
  )
}

export class SharedReplica {
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
        `Replica woke: object=${ctx.id.toString().slice(0, 8)} sockets=${attached.length} admitted=${attached.filter((socket) => attachment(socket)?.role).length}`,
      )
  }
  /** Open sockets whose hello was answered, writer and standbys. */
  admitted() {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN && attachment(socket)?.role)
  }
  /** The writer's open sockets: at most one, apart from one being replaced. */
  sockets() {
    return this.admitted().filter((socket) => attachment(socket)?.role === 'writer')
  }
  /** Tell every standby the writer, whether it is online and whether the lease is free. */
  announce(closing?: MachineSocket) {
    const online = this.sockets().some((socket) => socket !== closing)
    for (const socket of this.admitted())
      if (socket !== closing && attachment(socket)?.role === 'standby')
        socket.send(JSON.stringify(this.store.role('standby', online)))
  }
  /** Tell every machine, the writer too, its role again: the latest transition travels with it. */
  broadcast(closing?: MachineSocket) {
    const online = this.sockets().some((socket) => socket !== closing)
    for (const socket of this.admitted())
      if (socket !== closing)
        socket.send(JSON.stringify(this.store.role(attachment(socket)!.role!, online)))
  }
  /** The admitted standby socket of `machine`, if it is connected. */
  standby(machine: string) {
    return this.admitted().find(
      (socket) => attachment(socket)?.machine === machine && attachment(socket)?.role === 'standby',
    )
  }
  presence(closing?: MachineSocket) {
    const project = this.store.project(),
      lease = this.store.lease()
    if (!project || !lease) return
    const connected = new Set(
      this.admitted()
        .filter((socket) => socket !== closing)
        .map((socket) => attachment(socket)?.machine),
    )
    const known = this.store.machines()
    const machines = Object.entries(known)
      .map(([machine, { lastSeen }]) => ({
        machine,
        role: machine === lease.machine ? ('writer' as const) : ('standby' as const),
        connected: connected.has(machine),
        lastSeen,
      }))
      // The writer first, then standbys by name.
      .toSorted((a, b) => b.role.localeCompare(a.role) || a.machine.localeCompare(b.machine))
    const presence: Presence = {
      key: project.key,
      name: project.name,
      writer: {
        machine: lease.machine,
        online: this.sockets().some((socket) => socket !== closing),
        lastSeen: lease.machine === null ? undefined : known[lease.machine]?.lastSeen,
      },
      machines,
      count: this.store.summaryCount(),
      uiBuild: lease.uiBuild,
      ...(this.store.transition() ? { transition: this.store.transition() } : {}),
      hasEntries: this.store.hasEntries(),
    }
    this.ctx.waitUntil(
      directory(this.env)
        .fetch('https://directory/update', { method: 'POST', body: JSON.stringify(presence) })
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
        [
          'hello',
          'uiBuild',
          'batch',
          'summaries',
          'system',
          'models',
          'delivered',
          'release',
          'claim',
          'request-release',
          'release-waiting',
          'transition',
        ].includes(message?.type)
      )
        type = message.type
      const held = attachment(socket)
      if (message.type === 'hello') {
        if (!held || !validHello(message, held)) {
          socket.close(PROJECT_MISMATCH, 'invalid hello')
          return
        }
        // A target that comes back without its transition stopped preparing it.
        const abandoned = this.store.abandon(message.machine, message.transition)
        const replies = this.store.hello(
          { ...message, key: held.key },
          this.sockets().some((other) => other !== socket),
        )
        if (!replies) {
          socket.close(PROJECT_MISMATCH, 'root commit differs')
          return
        }
        const { role } = replies[0] as Extract<CloudMessage, { type: 'role' }>
        socket.serializeAttachment({
          ...held,
          machine: message.machine,
          role,
          checkout: { root: message.root, port: message.port, secrets: message.secrets },
        })
        if (role === 'writer') {
          for (const previous of this.sockets())
            if (previous !== socket) previous.close(1000, 'Replaced by new machine connection')
          for (const stream of this.streams) stream.close()
        }
        for (const reply of replies) socket.send(JSON.stringify(reply))
        if (abandoned) this.broadcast()
        else if (role === 'writer') this.announce()
        this.presence()
        return
      }
      if (message.type === 'claim') {
        if (
          held?.role !== 'standby' ||
          !held.machine ||
          !held.checkout ||
          !Number.isSafeInteger(message.epoch)
        )
          return
        const replies = this.store.claim(held.machine, held.checkout, message.epoch)
        if (!replies) {
          socket.send(JSON.stringify(this.store.role('standby', this.sockets().length > 0)))
          return
        }
        socket.serializeAttachment({ ...held, role: 'writer' })
        for (const stream of this.streams) stream.close()
        for (const reply of replies) socket.send(JSON.stringify(reply))
        this.announce()
        this.presence()
        return
      }
      if (message.type === 'request-release') {
        if (held?.role !== 'standby' || !held.machine || typeof message.id !== 'string') return
        for (const writer of this.sockets())
          writer.send(
            JSON.stringify({ type: 'release-requested', by: held.machine, id: message.id }),
          )
        return
      }
      if (message.type === 'transition') {
        if (!held?.role || !held.machine || !this.store.report(held.machine, message.value)) return
        this.broadcast()
        this.presence()
        return
      }
      // Only the writer's data is applied: a standby is fenced off.
      if (held?.role !== 'writer') return
      if (message.type === 'release-waiting') {
        if (typeof message.by !== 'string' || !Number.isSafeInteger(message.tasks)) return
        this.standby(message.by)?.send(
          JSON.stringify({ type: 'release-waiting', by: message.by, tasks: message.tasks }),
        )
        if (this.store.draining(message.by, message.tasks)) {
          this.broadcast()
          this.presence()
        }
        return
      }
      if (message.type === 'release') {
        if (
          !Number.isSafeInteger(message.epoch) ||
          typeof message.snapshot?.id !== 'string' ||
          !/^[\w-]{1,128}$/.test(message.snapshot.id) ||
          !this.store.release(message.epoch, message.snapshot.id)
        )
          return
        // The releasing socket stays as a standby and hears the free lease with the others.
        socket.serializeAttachment({ ...held, role: 'standby' })
        this.announce()
        this.presence()
        return
      }
      const hasEntries = this.store.hasEntries()
      const count = message.type === 'summaries' ? this.store.summaryCount() : undefined
      for (const reply of this.store.receive(message)) socket.send(JSON.stringify(reply))
      if (
        message.type === 'uiBuild' ||
        (count !== undefined && count !== this.store.summaryCount()) ||
        (message.type === 'batch' && hasEntries !== this.store.hasEntries())
      )
        this.presence()
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
    const held = attachment(socket)
    if (!held?.machine) return
    this.store.seen(held.machine)
    // The target's last socket closing ends its running transition, so nobody drains or waits for it.
    const gone =
      !this.admitted().some(
        (other) => other !== socket && attachment(other)?.machine === held.machine,
      ) && this.store.abandon(held.machine, undefined, true)
    if (gone) this.broadcast(socket)
    else if (held.role === 'writer' && !this.sockets().some((other) => other !== socket))
      this.announce(socket)
    this.presence(socket)
  }
  webSocketError(socket: MachineSocket) {
    socket.close(1011, 'Sync failed')
    this.webSocketClose(socket)
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/sync/v2') {
      if (
        !this.env.SYNC_TOKEN ||
        !matchesSyncToken(request.headers.get('Authorization'), this.env.SYNC_TOKEN)
      )
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return new Response('Expected WebSocket', { status: 426 })
      const key = url.searchParams.get('project')
      const alias = url.searchParams.get('alias') ?? undefined
      if (!key || !PROJECT_KEY.test(key) || (alias !== undefined && !PROJECT_KEY.test(alias)))
        return Response.json({ error: 'Expected a project key' }, { status: 400 })
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({ key, ...(alias ? { alias } : {}) } satisfies Attachment)
      const upgrade = { status: 101, webSocket: client }
      return new Response(null, upgrade)
    }
    if (!admitsRequest(request)) {
      await discardBody(request)
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    // The replica answers its own API before any request goes to the machine.
    if (url.pathname === '/api/cloud' || url.pathname.startsWith('/api/cloud/'))
      return this.cloud(request, url)
    const writer = this.store.lease()
    const bindings = JSON.parse(this.env.TUNNELS ?? '{}') as Record<string, `TUNNEL_${number}`>
    const binding = writer?.machine && this.env[bindings[writer.machine]]
    if (
      this.sockets().length &&
      writer &&
      Number.isInteger(writer.port) &&
      writer.port >= 1 &&
      writer.port <= 65535 &&
      (binding || this.env.MACHINE_ORIGIN)
    ) {
      try {
        const origin = new URL(binding ? 'http://127.0.0.1' : this.env.MACHINE_ORIGIN!)
        origin.port = String(writer.port)
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
  /**
   * `GET /api/cloud` lists machines, lease and transition; `POST /api/cloud/move {machine, force?}` asks that standby
   * to prepare and take the lease, `POST /api/cloud/cancel` stops the running transition.
   */
  async cloud(request: Request, url: URL) {
    const connected = new Set(this.admitted().map((socket) => attachment(socket)!.machine!))
    if (request.method === 'GET' && url.pathname === '/api/cloud')
      return Response.json(this.store.cloud(connected, this.sockets().length > 0))
    if (request.method !== 'POST') {
      await discardBody(request)
      return Response.json({ error: 'Unknown cloud route' }, { status: 404 })
    }
    const body = (await request.json().catch(() => ({}))) as {
      machine?: unknown
      force?: unknown
    }
    if (url.pathname === '/api/cloud/move') {
      if (typeof body.machine !== 'string')
        return Response.json({ error: 'Expected {machine}' }, { status: 400 })
      if (body.machine === this.store.lease()?.machine)
        return Response.json({ error: 'runs there already' }, { status: 409 })
      const target = this.standby(body.machine)
      if (!target) return Response.json({ error: 'not connected' }, { status: 409 })
      const id = crypto.randomUUID()
      target.send(
        JSON.stringify({ type: 'move-to', id, ...(body.force === true ? { force: true } : {}) }),
      )
      return Response.json({ id }, { status: 202 })
    }
    if (url.pathname === '/api/cloud/cancel') {
      const transition = this.store.transition()
      if (!transition?.cancellable || transition.error)
        return Response.json({ error: 'nothing to cancel' }, { status: 409 })
      const target = this.standby(transition.target)
      if (!target) return Response.json({ error: 'not connected' }, { status: 409 })
      target.send(JSON.stringify({ type: 'cancel', id: transition.id }))
      return Response.json({ id: transition.id }, { status: 202 })
    }
    return Response.json({ error: 'Unknown cloud route' }, { status: 404 })
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
