import type {
  R2Bucket,
  DurableObjectNamespace,
  DurableObjectState,
  Fetcher,
  WebSocket as MachineSocket,
  WebSocketPair as MachineSocketPair,
  WebSocketRequestResponsePair as MachinePingPair,
} from '@cloudflare/workers-types'
import { ReplicaStore } from './replica.ts'
import { admitsAccess } from './access.ts'
import type { AccessConfig } from './access.ts'

import type { Sql } from './replica.ts'
import { bounded, HELLO_LIMITS, PROJECT_KEY, PROJECT_MISMATCH, validTailnet } from './protocol.ts'
import type { CloudMessage, Hello, MachineMessage } from './protocol.ts'
import { DirectoryStore } from './directory.ts'
import { snapshotObject } from './snapshots.ts'
import type { Presence } from './directory.ts'

// Workers provides this constructor; Node-side request tests do not use WebSocket upgrades.
declare const WebSocketPair: typeof MachineSocketPair
declare const WebSocketRequestResponsePair: typeof MachinePingPair

interface Env extends AccessConfig {
  BUILDS: R2Bucket
  REPLICA: DurableObjectNamespace
  ASSETS: Fetcher
  DIRECTORY: DurableObjectNamespace
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

/** A machine's health report is a few providers' timestamps: 16 KiB is ample. */
const HEALTH_BODY = 16 * 1024

/** The body as text, or undefined once it exceeds `limit` bytes; reading stops there. */
async function limitedText(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get('Content-Length') ?? 0) > limit) {
    await discardBody(request)
    return undefined
  }
  if (!request.body) return ''
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0,
    text = ''
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.byteLength
      if (size > limit) {
        await reader.cancel()
        return undefined
      }
      text += decoder.decode(read.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return text + decoder.decode()
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

export default { fetch: route }

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const api = url.pathname === '/api' || url.pathname.startsWith('/api/')
  if (api && !(await admitsAccess(request, env)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (url.pathname.startsWith('/sync/snapshots/')) {
    if (!env.SYNC_TOKEN || !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const [, project = '', id = '', name = ''] =
      /^\/sync\/snapshots\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname) ?? []
    return snapshotObject(request, env.BUILDS, project, id, name)
  }
  // The front page is a static shell built by cloud/build.ts; its data comes from /api/directory behind Access.
  if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/front/', url), request))
  if (url.pathname === '/api/directory') return directory(env).fetch('https://directory/list')
  if (url.pathname === '/api/health') return directory(env).fetch('https://directory/health')
  if (url.pathname === '/sync/v2') {
    if (!env.SYNC_TOKEN || !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const key = url.searchParams.get('project')
    if (!key || !PROJECT_KEY.test(key))
      return Response.json({ error: 'Expected a project key' }, { status: 400 })
    // A relinked key syncs to its target's replica, which admits hellos naming either key.
    const target = await resolveKey(env, key)
    if (target === key) return env.REPLICA.get(env.REPLICA.idFromName(key)).fetch(request)
    url.searchParams.set('project', target)
    url.searchParams.set('alias', key)
    return env.REPLICA.get(env.REPLICA.idFromName(target)).fetch(new Request(url, request))
  }
  // Agents reach what the cloud UI does behind Access with the sync token instead.
  const agent = AGENT_ROUTES[url.pathname]
  if (agent) {
    if (!env.SYNC_TOKEN || !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    if (request.method !== agent.method) {
      await discardBody(request)
      return new Response('Method not allowed', { status: 405 })
    }
    if (url.pathname === '/sync/directory') return directory(env).fetch('https://directory/list')
    const key = url.searchParams.get('project')
    if (!key || !PROJECT_KEY.test(key)) {
      await discardBody(request)
      return Response.json({ error: 'Expected a project key' }, { status: 400 })
    }
    const target = await resolveKey(env, key)
    // A fresh request: the replica's own handler answers it, without the caller's headers.
    return env.REPLICA.get(env.REPLICA.idFromName(target)).fetch(
      new Request(`https://replica${agent.path}`, {
        method: agent.method,
        ...(agent.method === 'POST' ? { body: await request.text() } : {}),
      }),
    )
  }
  // Each machine reports its model providers' health; the front page and @sync list it. No project key: it is the
  // machine's, like `/sync/directory`.
  if (url.pathname === '/sync/health') {
    if (
      !env.SYNC_TOKEN ||
      !matchesSyncToken(request.headers.get('Authorization'), env.SYNC_TOKEN)
    ) {
      await discardBody(request)
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (request.method === 'GET') return directory(env).fetch('https://directory/health')
    if (request.method !== 'POST') {
      await discardBody(request)
      return new Response('Method not allowed', { status: 405 })
    }
    const body = await limitedText(request, HEALTH_BODY)
    if (body === undefined)
      return Response.json({ error: 'At most 16 KiB of health' }, { status: 413 })
    // PUT, not POST: a directory object still on code from before this route treats any POST as a presence update and
    // throws on it, while a PUT there falls through to a harmless 404 that the reporter retries.
    return directory(env).fetch('https://directory/health', { method: 'PUT', body })
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
  if (api) return Response.json({ error: 'Not found' }, { status: 404 })
  return env.ASSETS.fetch(request)
}

function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))
}

/** The key whose replica serves `key`: the one it was relinked to, or itself. */
async function resolveKey(env: Env, key: string) {
  const alias = await directory(env).fetch(`https://directory/alias?key=${encodeURIComponent(key)}`)
  if (!alias.ok) return key
  const { target }: { target: string } = await alias.json()
  return target
}

/**
 * @sync's bearer routes, by path: the method and the replica route that answers. The replica paths are the ones its
 * deployed code already answers, so a Worker deployed ahead of its objects keeps working.
 */
const AGENT_ROUTES: Record<string, { method: 'GET' | 'POST'; path: string }> = {
  '/sync/directory': { method: 'GET', path: '' },
  '/sync/cloud': { method: 'GET', path: '/api/cloud' },
  '/sync/move': { method: 'POST', path: '/sync/move' },
  '/sync/cancel': { method: 'POST', path: '/api/cloud/cancel' },
}

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
    if (url.pathname === '/health') {
      if (request.method !== 'PUT') return Response.json(this.store.healthList())
      let value: unknown
      try {
        value = await request.json()
      } catch {
        return Response.json({ error: 'Expected JSON' }, { status: 400 })
      }
      return this.store.health(value)
        ? new Response(null, { status: 204 })
        : Response.json({ error: 'Invalid machine health' }, { status: 400 })
    }
    if (request.method === 'POST') {
      const presence: Partial<Presence> | null = await request.json()
      if (typeof presence?.key !== 'string' || typeof presence.name !== 'string')
        return Response.json({ error: 'Expected a project presence' }, { status: 400 })
      this.store.update(presence as Presence)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/list') return Response.json(this.store.list())
    return Response.json({ error: 'Unknown directory route' }, { status: 404 })
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
  checkout?: { root: string; port: number; secrets: string[]; secretsComplete: boolean }
}
const attachment = (socket: MachineSocket) =>
  socket.deserializeAttachment() as Attachment | null | undefined

/** Secret names as hello carries them: bounded, names only. */
const validSecrets = ({ secrets, secretsComplete }: Pick<Hello, 'secrets' | 'secretsComplete'>) =>
  Array.isArray(secrets) &&
  secrets.length <= HELLO_LIMITS.secrets &&
  secrets.every((name) => typeof name === 'string' && HELLO_LIMITS.secret.test(name)) &&
  typeof secretsComplete === 'boolean'

function validHello(hello: Hello, { key, alias }: Attachment) {
  return (
    (hello.key === key || hello.key === alias) &&
    typeof hello.rootCommit === 'string' &&
    /^[0-9a-f]{40,64}$/.test(hello.rootCommit) &&
    typeof hello.root === 'string' &&
    hello.root.startsWith('/') &&
    hello.root.length <= HELLO_LIMITS.root &&
    typeof hello.machine === 'string' &&
    hello.machine.length > 0 &&
    hello.machine.length <= HELLO_LIMITS.machine &&
    Number.isInteger(hello.port) &&
    hello.port >= 1 &&
    hello.port <= 65535 &&
    (hello.epoch === undefined || (Number.isSafeInteger(hello.epoch) && hello.epoch >= 1)) &&
    typeof hello.history === 'boolean' &&
    validSecrets(hello) &&
    (hello.tailnet === undefined || validTailnet(hello.tailnet)) &&
    (hello.transition === undefined ||
      (typeof hello.transition === 'string' && /^[\w-]{1,64}$/.test(hello.transition)))
  )
}

export class SharedReplica {
  readonly ctx: DurableObjectState
  readonly env: Env
  readonly store: ReplicaStore
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
    this.store = new ReplicaStore({
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (run) => ctx.storage.transactionSync(run),
    } as Sql)
    // Machines check their socket is alive with `ping`; the runtime answers without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
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
      .map(([machine, { lastSeen, tailnet }]) => ({
        machine,
        role: machine === lease.machine ? ('writer' as const) : ('standby' as const),
        connected: connected.has(machine),
        lastSeen,
        ...(tailnet ? { tailnet } : {}),
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
        ...(this.store.tailnet() ? { tailnet: this.store.tailnet() } : {}),
      },
      machines,
      ...(this.store.transition() ? { transition: this.store.transition() } : {}),
    }
    this.ctx.waitUntil(
      directory(this.env)
        .fetch('https://directory/update', { method: 'POST', body: JSON.stringify(presence) })
        .then(() => {}),
    )
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
          'release',
          'claim',
          'request-release',
          'release-waiting',
          'transition',
          'secrets',
          'tailnet',
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
          checkout: {
            root: message.root,
            port: message.port,
            secrets: message.secrets,
            secretsComplete: message.secretsComplete,
          },
        })
        if (role === 'writer')
          for (const previous of this.sockets())
            if (previous !== socket) previous.close(1000, 'Replaced by new machine connection')
        for (const reply of replies) socket.send(JSON.stringify(reply))
        if (abandoned) this.broadcast()
        else if (role === 'writer') this.announce()
        this.presence()
        return
      }
      if (message.type === 'claim') {
        if (held?.role !== 'standby' || !Number.isSafeInteger(message.epoch)) return
        // Admitted before sockets kept their checkout: reconnecting sends a fresh hello, after which the claim's
        // reconciliation settles it, so the claimant never waits on a claim nobody will answer.
        if (!held.machine || !held.checkout) {
          socket.close(1012, 'Say hello again')
          return
        }
        const replies = this.store.claim(held.machine, held.checkout, message.epoch)
        if (!replies) {
          socket.send(JSON.stringify(this.store.role('standby', this.sockets().length > 0)))
          return
        }
        socket.serializeAttachment({ ...held, role: 'writer' })
        for (const reply of replies) socket.send(JSON.stringify(reply))
        this.announce()
        this.presence()
        return
      }
      if (message.type === 'request-release') {
        if (held?.role !== 'standby' || !held.machine || typeof message.id !== 'string') return
        for (const writer of this.sockets())
          writer.send(
            JSON.stringify({
              type: 'release-requested',
              by: held.machine,
              id: message.id,
              ...(message.force === true ? { force: true } : {}),
            }),
          )
        return
      }
      if (message.type === 'transition') {
        if (!held?.role || !held.machine || !this.store.report(held.machine, message.value)) return
        this.broadcast()
        this.presence()
        return
      }
      // Writer and standbys both keep their secret names current, so a standby's missing secrets refresh.
      if (message.type === 'secrets') {
        if (!held?.role || !held.machine || !held.checkout || !validSecrets(message)) return
        const { secrets, secretsComplete } = message
        socket.serializeAttachment({
          ...held,
          checkout: { ...held.checkout, secrets, secretsComplete },
        })
        this.store.secrets(held.machine, held.checkout.root, held.role === 'writer', {
          secrets,
          secretsComplete,
        })
        this.broadcast()
        return
      }
      // Writer and standbys both report where they answer on the tailnet; the writer's shows on the front page.
      if (message.type === 'tailnet') {
        if (!held?.role || !held.machine || !held.checkout) return
        if (message.url !== null && !validTailnet(message.url)) return
        if (this.store.setTailnet(held.machine, held.checkout.root, message.url)) {
          this.broadcast()
          this.presence()
        }
        return
      }
      // Only the writer's messages count from here: a standby is fenced off.
      if (held?.role !== 'writer') return
      if (message.type === 'release-waiting') {
        const { by, tasks, dirty, runs, unchecked } = message
        if (
          typeof by !== 'string' ||
          !Number.isSafeInteger(tasks) ||
          !bounded(dirty) ||
          !bounded(runs) ||
          !bounded(unchecked === undefined ? undefined : [unchecked])
        )
          return
        const waiting = {
          by,
          tasks,
          ...(dirty ? { dirty } : {}),
          ...(runs ? { runs } : {}),
          ...(message.held === true ? { held: true } : {}),
          ...(unchecked ? { unchecked } : {}),
        }
        this.standby(by)?.send(JSON.stringify({ type: 'release-waiting', ...waiting }))
        if (this.store.draining({ ...waiting, from: held.machine! })) {
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
      }
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
    // Only the Worker's bearer routes reach these paths (`AGENT_ROUTES`).
    const connected = new Set(this.admitted().map((socket) => attachment(socket)!.machine!))
    if (request.method === 'GET' && url.pathname === '/api/cloud')
      return Response.json(this.store.cloud(connected, this.sockets().length > 0))
    if (request.method !== 'POST') {
      await discardBody(request)
      return Response.json({ error: 'Unknown replica route' }, { status: 404 })
    }
    const body = (await request.json().catch(() => ({}))) as {
      machine?: unknown
      force?: unknown
    }
    // `POST /sync/move {machine, force?}` asks that standby to prepare and take the lease, started by @sync.
    if (url.pathname === '/sync/move') {
      if (typeof body.machine !== 'string')
        return Response.json({ error: 'Expected {machine}' }, { status: 400 })
      if (body.machine === this.store.lease()?.machine)
        return Response.json({ error: 'runs there already' }, { status: 409 })
      const target = this.standby(body.machine)
      if (!target) return Response.json({ error: 'not connected' }, { status: 409 })
      const id = crypto.randomUUID()
      target.send(
        JSON.stringify({
          type: 'move-to',
          id,
          by: 'sync',
          ...(body.force === true ? { force: true } : {}),
        } satisfies CloudMessage),
      )
      return Response.json({ id }, { status: 202 })
    }
    // `POST /api/cloud/cancel` stops the running transition.
    if (url.pathname === '/api/cloud/cancel') {
      const transition = this.store.transition()
      if (!transition?.cancellable || transition.error)
        return Response.json({ error: 'nothing to cancel' }, { status: 409 })
      const target = this.standby(transition.target)
      if (!target) return Response.json({ error: 'not connected' }, { status: 409 })
      target.send(JSON.stringify({ type: 'cancel', id: transition.id }))
      return Response.json({ id: transition.id }, { status: 202 })
    }
    return Response.json({ error: 'Unknown replica route' }, { status: 404 })
  }
}
