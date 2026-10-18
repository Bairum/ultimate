import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedReplica } from '../cloud/worker.ts'
import type { ConversationRecord, EntryRecord } from '@earendil-works/pi-durable'
import { ReplicaStore, proxyRequest } from '../cloud/replica.ts'
import type { Sql } from '../cloud/replica.ts'
import { DirectoryStore } from '../cloud/directory.ts'
import type { Presence } from '../cloud/directory.ts'
import { PROJECT_MISMATCH } from '../cloud/protocol.ts'
import type {
  CloudMessage,
  Hello,
  MachineMessage,
  ReplicaDoc,
  Transition,
} from '../cloud/protocol.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function replica(rowsRead?: (count: number) => void) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql: Sql = {
    exec: <T extends Record<string, unknown>>(
      query: string,
      ...bindings: (string | number | null)[]
    ) => {
      const statement = db.prepare(query)
      if (statement.columns().length) {
        const rows = statement.all(...bindings) as T[]
        rowsRead?.(rows.length)
        return rows
      }
      statement.run(...bindings)
      return []
    },
    transaction: (run) => {
      db.exec('BEGIN')
      try {
        const result = run()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return new ReplicaStore(sql)
}
type Socket = ReturnType<SharedReplica['sockets']>[number]
const KEY = 'github.com/hazat/test'
const ROOT_COMMIT = 'a'.repeat(40)
const hello = (overrides: Partial<Hello> = {}): Hello => ({
  type: 'hello',
  key: KEY,
  rootCommit: ROOT_COMMIT,
  root: '/test',
  machine: 'test',
  port: 4800,
  build: 'test',
  history: false,
  secrets: [],
  ...overrides,
})
/** The laptop preparing a move, downloading. */
const running = (id: string): Transition => ({
  id,
  target: 'laptop',
  from: 'test',
  step: 'download',
  steps: [
    { name: 'fetch', state: 'done' },
    { name: 'download', state: 'running' },
  ],
  cancellable: true,
  startedAt: 1,
})
function worker(online = false) {
  const instance = Object.assign(Object.create(SharedReplica.prototype) as SharedReplica, {
    store: replica(),
    streams: new Set(),
    env: { MACHINE_ORIGIN: 'http://127.0.0.1:4800' },
  })
  instance.store.hello(hello(), false)
  vi.spyOn(instance, 'sockets').mockReturnValue(
    online ? [{ send: vi.fn<() => void>() } as unknown as Socket] : [],
  )
  return instance
}
/** A replica with fake sockets that records what it reports to the Directory. */
function shared() {
  const sockets: Socket[] = []
  const updates: Presence[] = []
  const instance = Object.assign(Object.create(SharedReplica.prototype) as SharedReplica, {
    store: replica(),
    streams: new Set(),
    ctx: { getWebSockets: () => sockets, waitUntil: vi.fn<() => void>() },
    env: {
      DIRECTORY: {
        idFromName: () => 'directory',
        get: () => ({
          fetch: async (_url: string, init: RequestInit) => {
            updates.push(JSON.parse(init.body as string))
            return new Response()
          },
        }),
      },
    },
  })
  const connect = (key = KEY) => {
    let attachment: unknown = { key }
    const socket = {
      readyState: WebSocket.OPEN as number,
      send: vi.fn<(data: string) => void>(),
      close: vi.fn<(code?: number, reason?: string) => void>(() => {
        socket.readyState = WebSocket.CLOSED
      }),
      serializeAttachment: (value: unknown) => {
        attachment = value
      },
      deserializeAttachment: () => attachment,
    }
    sockets.push(socket as unknown as Socket)
    return {
      socket,
      machine: socket as unknown as Socket,
      receive: (message: MachineMessage) =>
        instance.webSocketMessage(socket as unknown as Socket, JSON.stringify(message)),
      sent: () => socket.send.mock.calls.map(([data]) => JSON.parse(data) as CloudMessage),
    }
  }
  return { instance, connect, updates }
}
const submitRequest = (headers: Record<string, string> = {}) =>
  new Request('https://cloud.example/api/conversations/1/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ text: 'prompt' }),
  })
const conversation = (id: number, parent?: { conversationId: number; at: number }) =>
  ({ id, ...(parent ? { parent } : {}) }) as ConversationRecord
const entry = (id: number, conversationId = 1, head?: number) =>
  ({
    id: id as EntryRecord['id'],
    conversationId: conversationId as EntryRecord['conversationId'],
    kind: 'pi.user',
    data: { text: `entry ${id}` },
    ...(head !== undefined ? { head: head as EntryRecord['head'] } : {}),
  }) as EntryRecord
const doc = (id: number, kind = 'pi.agent'): ReplicaDoc => ({
  id,
  kind,
  conversationId: 1,
  value: { test: true },
  hash: `hash-${id}`,
})
function batch(
  store: ReplicaStore,
  entries: EntryRecord[] = [],
  docs: ReplicaDoc[] = [],
  conversations = [conversation(1)],
) {
  const message: MachineMessage = { type: 'batch', batch: 1, conversations, entries, docs }
  return store.receive(message)
}

it.each([
  ['{"type":"batch","private":"do not log 🐈"}', 'batch'],
  ['{"type":"do not log","private":"do not log"}', 'unknown'],
  ['{"private":"do not log"', 'unknown'],
])('logs only message type and byte size on WebSocket exceptions: %s', (raw, type) => {
  const instance = worker()
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ key: KEY, machine: 'test', role: 'writer' }),
  } as unknown as Socket
  Object.assign(instance, { ctx: { getWebSockets: () => [socket] } })
  const error = new Error('private exception detail')
  const receive = vi.spyOn(instance.store, 'receive').mockImplementation(() => {
    throw error
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const message of [raw, new TextEncoder().encode(raw).buffer]) {
    expect(() => instance.webSocketMessage(socket, message)).toThrow(
      raw.endsWith('}') ? error : SyntaxError,
    )
    expect(log).toHaveBeenLastCalledWith(
      `Cloud sync WebSocket exception: type=${type} bytes=${Buffer.byteLength(raw)}`,
    )
  }
  expect(log).toHaveBeenCalledTimes(2)
  receive.mockReturnValue([])
  instance.webSocketMessage(socket, '{"type":"models","value":[]}')
  expect(log).toHaveBeenCalledTimes(2)
})

describe('cloud request admission and fallback', () => {
  it.each([false, true])(
    'rejects foreign Origin and cross-site POSTs before %s online forwarding or enqueueing',
    async (online) => {
      const instance = worker(online)
      const forward = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }))
      vi.stubGlobal('fetch', forward)
      for (const headers of [
        { 'Sec-Fetch-Site': 'cross-site' },
        { 'Sec-Fetch-Site': 'same-site' },
        { Origin: 'https://evil.example' },
        { Origin: 'null' },
      ] as Record<string, string>[]) {
        const response = await instance.fetch(submitRequest(headers))
        expect(response.status).toBe(403)
      }
      expect(forward).not.toHaveBeenCalled()
      expect(instance.store.outbox()).toEqual([])
      const allowed = await instance.fetch(
        submitRequest({ Origin: 'https://cloud.example', 'Sec-Fetch-Site': 'same-origin' }),
      )
      expect(allowed.status).toBe(online ? 200 : 202)
      expect(forward).toHaveBeenCalledTimes(online ? 1 : 0)
      expect(instance.store.outbox()).toHaveLength(online ? 0 : 1)
    },
  )
  it('allows absent browser headers and Sec-Fetch-Site none, but checks proxy headers before rewriting', () => {
    for (const headers of [{}, { 'Sec-Fetch-Site': 'none' }] as Record<string, string>[])
      expect(
        proxyRequest(submitRequest(headers), 'http://127.0.0.1:4800').headers.get('Host'),
      ).toBe('127.0.0.1:4800')
    expect(() =>
      proxyRequest(submitRequest({ Origin: 'https://evil.example' }), 'http://127.0.0.1:4800'),
    ).toThrow('Forbidden')
  })
  it('uses the VPC binding with loopback admission headers and streams SSE unchanged', async () => {
    const instance = worker(true)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: test\ndata: {}\n\n'))
        controller.close()
      },
    })
    const response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    const forward = vi.fn<(request: Request) => Promise<Response>>(async (request) => {
      expect(request.url).toBe('http://127.0.0.1:4800/api/events?conversation=1')
      expect([...request.headers.entries()]).toEqual([
        ['host', '127.0.0.1:4800'],
        ['origin', 'http://127.0.0.1:4800'],
      ])
      return response
    })
    Object.assign(instance.env, {
      TUNNELS: JSON.stringify({ test: 'TUNNEL_0' }),
      TUNNEL_0: { fetch: forward },
    })
    const direct = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', direct)
    const result = await instance.fetch(
      new Request('https://cloud.example/api/events?conversation=1', {
        headers: {
          Origin: 'https://cloud.example',
          'Cf-Access-Jwt-Assertion': 'removed',
          'Sec-Fetch-Site': 'same-origin',
          'X-Forwarded-Host': 'cloud.example',
        },
      }),
    )
    expect(result).toBe(response)
    expect(result.body).toBe(body)
    expect(await result.text()).toBe('event: test\ndata: {}\n\n')
    expect(forward).toHaveBeenCalledTimes(1)
    expect(direct).not.toHaveBeenCalled()
  })
  it('never enqueues an ambiguous proxied write, while failed GETs fall back', async () => {
    const instance = worker(true)
    vi.stubGlobal(
      'fetch',
      vi.fn<() => void>().mockRejectedValue(new Error('Response lost after commit')),
    )
    const response = await instance.fetch(submitRequest())
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'The machine did not answer; check before retrying',
    })
    expect(instance.store.outbox()).toEqual([])
    const read = await instance.fetch(new Request('https://cloud.example/api/models'))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ providers: [], models: [] })
  })
  it('publishes only a notice until a machine has synced a valid system', async () => {
    const instance = worker()
    const response = await instance.fetch(new Request('https://cloud.example/api/events'))
    const reader = response.body!.getReader()
    let events = ''
    for (let chunk = 0; chunk < 2; chunk++) {
      const { value } = await reader.read()
      events += new TextDecoder().decode(value)
    }
    await reader.cancel()
    expect(events).not.toContain('event: system')
    expect(events).toBe(
      'retry: 500\n\nevent: notice\ndata: {"level":"warning","message":"No machine has synced yet"}\n\n',
    )
    expect(instance.streams.size).toBe(0)
  })
})

const types = (messages: CloudMessage[]) => messages.map((message) => message.type)

describe('project replica sockets', () => {
  it('registers an unknown project with its first machine as writer at epoch 1', () => {
    const { instance, connect, updates } = shared()
    const first = connect()
    first.receive(hello({ secrets: ['OPENAI_API_KEY'] }))
    expect(first.sent()).toEqual([
      {
        type: 'role',
        role: 'writer',
        epoch: 1,
        free: false,
        writer: {
          machine: 'test',
          root: '/test',
          epoch: 1,
          online: true,
          secrets: ['OPENAI_API_KEY'],
        },
      },
      { type: 'cursor', entries: {}, docs: {} },
      { type: 'outbox', items: [] },
    ])
    expect(instance.store.project()).toEqual({
      key: KEY,
      rootCommit: ROOT_COMMIT,
      root: '/test',
      name: 'test',
    })
    expect(instance.sockets()).toEqual([first.machine])
    expect(updates.at(-1)).toMatchObject({
      key: KEY,
      name: 'test',
      writer: { machine: 'test', online: true },
      machines: [{ machine: 'test', role: 'writer', connected: true }],
      count: 0,
      hasEntries: false,
    })
  })

  it('makes a second machine a standby whose data is ignored, and tells it when the writer comes and goes', () => {
    const { instance, connect, updates } = shared()
    const writer = connect()
    writer.receive(hello({ secrets: ['GITHUB_TOKEN'] }))
    writer.receive({
      type: 'batch',
      batch: 1,
      conversations: [conversation(1)],
      entries: [entry(1)],
      docs: [],
    })
    const { item } = instance.store.enqueue(1, 'queued')
    const standby = connect()
    standby.receive(hello({ machine: 'laptop', root: '/home/me/test', history: true }))
    expect(standby.sent()).toEqual([
      {
        type: 'role',
        role: 'standby',
        epoch: 1,
        free: false,
        writer: {
          machine: 'test',
          root: '/test',
          epoch: 1,
          online: true,
          secrets: ['GITHUB_TOKEN'],
        },
      },
    ])
    const snapshot = () =>
      ['metadata', 'conversations', 'entries', 'docs', 'outbox', 'summaries'].map((table) => [
        ...instance.store.sql.exec(`SELECT * FROM ${table} ORDER BY 1`),
      ])
    const before = snapshot()
    standby.receive({
      type: 'batch',
      batch: 1,
      conversations: [conversation(99)],
      entries: [entry(2)],
      docs: [doc(1)],
    })
    standby.receive({
      type: 'summaries',
      value: [{ id: 1, title: 'mine', busy: false }],
      removed: [],
      full: true,
    })
    standby.receive({ type: 'uiBuild', value: '0123456789ab' })
    standby.receive({ type: 'system', value: {} as never })
    standby.receive({ type: 'delivered', id: item.id, submissionId: 1 })
    expect(snapshot()).toEqual(before)
    expect(standby.sent()).toHaveLength(1)
    expect(instance.sockets()).toEqual([writer.machine])
    expect(writer.socket.close).not.toHaveBeenCalled()
    expect(updates.at(-1)?.machines).toEqual([
      { machine: 'test', role: 'writer', connected: true, lastSeen: expect.any(Number) },
      { machine: 'laptop', role: 'standby', connected: true, lastSeen: expect.any(Number) },
    ])

    writer.socket.readyState = WebSocket.CLOSED
    instance.webSocketClose(writer.machine)
    expect(standby.sent().at(-1)).toMatchObject({ role: 'standby', writer: { online: false } })
    expect(updates.at(-1)).toMatchObject({
      writer: { machine: 'test', online: false },
      machines: [
        { machine: 'test', connected: false },
        { machine: 'laptop', connected: true },
      ],
    })
    const back = connect()
    back.receive(hello({ epoch: 1 }))
    expect(types(back.sent())).toEqual(['role', 'cursor', 'outbox'])
    expect(standby.sent().at(-1)).toMatchObject({ role: 'standby', writer: { online: true } })
    expect(standby.sent()).toHaveLength(3)
  })

  it('makes a socket naming a stale epoch a standby, even from the writer machine', () => {
    const { instance, connect } = shared()
    connect().receive(hello())
    // A later move (not part of this protocol yet) would have raised the epoch.
    instance.store.sql.exec(
      'UPDATE metadata SET value=? WHERE id=5',
      JSON.stringify({ ...instance.store.lease(), epoch: 3 }),
    )
    for (const claim of [
      hello({ epoch: 2 }),
      hello({ epoch: 4 }),
      hello({ machine: 'laptop', epoch: 3 }),
    ]) {
      const socket = connect()
      socket.receive(claim)
      expect(socket.sent()).toEqual([
        expect.objectContaining({ type: 'role', role: 'standby', epoch: 3 }),
      ])
    }
    const current = connect()
    current.receive(hello({ epoch: 3 }))
    expect(current.sent()[0]).toMatchObject({ role: 'writer', epoch: 3 })
  })

  it('lets the writer machine reconnect without a lease file, replacing its previous socket', () => {
    const { instance, connect } = shared()
    const first = connect()
    first.receive(hello())
    instance.store.sql.exec(
      'UPDATE metadata SET value=? WHERE id=5',
      JSON.stringify({ ...instance.store.lease(), epoch: 2 }),
    )
    const reinstalled = connect()
    reinstalled.receive(hello({ port: 4801 }))
    // The role carries the epoch, so the machine rewrites its lease file.
    expect(reinstalled.sent()[0]).toMatchObject({ type: 'role', role: 'writer', epoch: 2 })
    expect(types(reinstalled.sent())).toEqual(['role', 'cursor', 'outbox'])
    expect(first.socket.close).toHaveBeenCalledWith(1000, 'Replaced by new machine connection')
    expect(instance.sockets()).toEqual([reinstalled.machine])
    expect(instance.store.lease()).toMatchObject({ machine: 'test', epoch: 2, port: 4801 })
  })

  it('hands a released lease to the claiming machine at the next epoch', () => {
    const { instance, connect, updates } = shared()
    const writer = connect()
    writer.receive(hello())
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop', root: '/home/me/test', port: 4900, secrets: ['A'] }))
    // Releasing needs the current epoch; a stale or foreign release changes nothing.
    writer.receive({ type: 'release', epoch: 2, snapshot: { id: 'snap-1' } })
    laptop.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    expect(instance.store.lease()?.machine).toBe('test')
    writer.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    const free = {
      type: 'role',
      role: 'standby',
      epoch: 1,
      free: true,
      snapshot: { id: 'snap-1', epoch: 1 },
      writer: { machine: null, root: '/test', epoch: 1, online: false, secrets: [] },
    }
    expect(writer.sent().at(-1)).toEqual(free)
    expect(laptop.sent().at(-1)).toEqual(free)
    expect(instance.sockets()).toEqual([])
    expect(updates.at(-1)?.writer).toEqual({ machine: null, online: false })
    // The released socket is a standby now: its data is ignored.
    writer.receive({ type: 'batch', batch: 9, conversations: [], entries: [entry(1)], docs: [] })
    expect(instance.store.hasEntries()).toBe(false)

    laptop.receive({ type: 'claim', epoch: 1 })
    expect(laptop.sent().slice(-3)).toEqual([
      {
        ...free,
        role: 'writer',
        epoch: 2,
        free: false,
        writer: {
          machine: 'laptop',
          root: '/home/me/test',
          epoch: 2,
          online: true,
          secrets: ['A'],
        },
      },
      { type: 'cursor', entries: {}, docs: {} },
      { type: 'outbox', items: [] },
    ])
    expect(instance.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2, port: 4900 })
    expect(instance.sockets()).toEqual([laptop.machine])
    expect(writer.sent().at(-1)).toMatchObject({
      role: 'standby',
      free: false,
      writer: { machine: 'laptop', online: true },
    })
    expect(updates.at(-1)?.writer).toMatchObject({ machine: 'laptop', online: true })
    expect(updates.at(-1)?.machines.map((machine) => [machine.machine, machine.role])).toEqual([
      ['laptop', 'writer'],
      ['test', 'standby'],
    ])
  })

  it('keeps the target transition, sends it to every machine and patches the writer drain into its handover', () => {
    const { instance, connect, updates } = shared()
    const writer = connect()
    writer.receive(hello())
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop' }))
    const desk = connect()
    desk.receive(hello({ machine: 'desk' }))
    const transition: Transition = {
      id: 'move-1',
      target: 'laptop',
      from: 'test',
      step: 'handover',
      steps: [
        { name: 'fetch', state: 'done', detail: 'main is up to date' },
        { name: 'handover', state: 'running' },
      ],
      cancellable: true,
      startedAt: 1,
    }
    // Only the target reports its transition.
    desk.receive({ type: 'transition', value: transition })
    expect(instance.store.transition()).toBeUndefined()
    laptop.receive({
      type: 'transition',
      value: { ...transition, steps: [{ name: 'x' }] } as never,
    })
    expect(instance.store.transition()).toBeUndefined()
    laptop.receive({ type: 'transition', value: transition })
    for (const machine of [writer, laptop, desk])
      expect(machine.sent().at(-1)).toMatchObject({ type: 'role', transition })
    expect(writer.sent().at(-1)).toMatchObject({ role: 'writer' })
    expect(updates.at(-1)?.transition).toEqual(transition)

    laptop.receive({ type: 'request-release', id: 'move-1' })
    expect(writer.sent().at(-1)).toEqual({ type: 'release-requested', by: 'laptop', id: 'move-1' })
    const before = desk.sent().length
    writer.receive({ type: 'release-waiting', by: 'laptop', tasks: 2 })
    expect(laptop.sent().at(-2)).toEqual({ type: 'release-waiting', by: 'laptop', tasks: 2 })
    expect(instance.store.transition()?.steps[1]).toEqual({
      name: 'handover',
      state: 'running',
      detail: 'finishing 2 runs',
    })
    expect(desk.sent().at(-1)).toMatchObject({
      type: 'role',
      transition: { steps: [{ name: 'fetch' }, { detail: 'finishing 2 runs' }] },
    })
    // Only a standby asks, and only the writer answers.
    const writes = writer.sent().length
    writer.receive({ type: 'request-release', id: 'move-1' })
    laptop.receive({ type: 'release-waiting', by: 'desk', tasks: 1 })
    expect(writer.sent()).toHaveLength(writes)
    expect(desk.sent()).toHaveLength(before + 1)
    // Only the target clears it.
    desk.receive({ type: 'transition', value: null })
    expect(instance.store.transition()).toBeDefined()
    laptop.receive({ type: 'transition', value: null })
    expect(instance.store.transition()).toBeUndefined()
  })

  it('fails a target transition when the target goes away or comes back without it', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    const failed = {
      error: 'laptop disconnected',
      cancellable: false,
      steps: [
        { name: 'fetch', state: 'done' },
        { name: 'download', state: 'failed', detail: 'laptop disconnected' },
      ],
    }
    // Its last socket closing ends it; a second socket of the same machine keeps it.
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop' }))
    laptop.receive({ type: 'transition', value: running('move-1') })
    const second = connect()
    second.receive(hello({ machine: 'laptop', transition: 'move-1' }))
    laptop.socket.readyState = WebSocket.CLOSED
    instance.webSocketClose(laptop.machine)
    expect(instance.store.transition()?.error).toBeUndefined()
    second.socket.readyState = WebSocket.CLOSED
    instance.webSocketClose(second.machine)
    expect(instance.store.transition()).toMatchObject(failed)
    expect(writer.sent().at(-1)).toMatchObject({ role: 'writer', transition: failed })
    // A hello that names another transition, or none, ends the stored one.
    const back = connect()
    back.receive(hello({ machine: 'laptop' }))
    back.receive({ type: 'transition', value: running('move-2') })
    connect().receive(hello({ machine: 'laptop' }))
    expect(instance.store.transition()).toMatchObject({ id: 'move-2', ...failed })
    // The writer it waits for may reconnect while releasing, naming it, and close sockets on the way; a writer that
    // comes back without it restarted and keeps its lease.
    const target = connect()
    target.receive(hello({ machine: 'laptop', transition: 'move-3' }))
    target.receive({ type: 'transition', value: running('move-3') })
    writer.socket.readyState = WebSocket.CLOSED
    instance.webSocketClose(writer.machine)
    connect().receive(hello({ transition: 'move-3' }))
    expect(instance.store.transition()?.error).toBeUndefined()
    connect().receive(hello())
    expect(instance.store.transition()).toMatchObject({
      id: 'move-3',
      error: 'test disconnected',
    })
  })

  it('answers /api/cloud itself while the writer is online, and forwards moves and cancels to the target', async () => {
    const { instance, connect } = shared()
    Object.assign(instance.env, { MACHINE_ORIGIN: 'http://127.0.0.1' })
    const machine = vi.fn<typeof fetch>(async () => new Response('from the machine'))
    vi.stubGlobal('fetch', machine)
    const writer = connect()
    writer.receive(hello({ secrets: ['A', 'B'] }))
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop', root: '/laptop', secrets: ['A'] }))
    const api = (path: string, body?: unknown) =>
      instance.fetch(
        new Request(`https://cloud.example${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    expect(await (await api('/api/models')).text()).toBe('from the machine')
    machine.mockClear()
    expect(await (await api('/api/cloud')).json()).toEqual({
      machines: [
        expect.objectContaining({
          machine: 'test',
          role: 'writer',
          connected: true,
          root: '/test',
          missingSecrets: [],
        }),
        expect.objectContaining({
          machine: 'laptop',
          role: 'standby',
          connected: true,
          root: '/laptop',
          missingSecrets: ['B'],
        }),
      ],
      lease: { machine: 'test', epoch: 1, root: '/test', online: true },
      transition: null,
    })
    const moved = await api('/api/cloud/move', { machine: 'laptop', force: true })
    expect(moved.status).toBe(202)
    const { id } = (await moved.json()) as { id: string }
    expect(laptop.sent().at(-1)).toEqual({ type: 'move-to', id, force: true })
    for (const [body, error] of [
      [{ machine: 'test' }, 'runs there already'],
      [{ machine: 'desk' }, 'not connected'],
    ] as const) {
      const refused = await api('/api/cloud/move', body)
      expect({ status: refused.status, body: await refused.json() }).toEqual({
        status: 409,
        body: { error },
      })
    }
    expect((await api('/api/cloud/cancel', {})).status).toBe(409)
    laptop.receive({
      type: 'transition',
      value: {
        id,
        target: 'laptop',
        from: 'test',
        step: 'fetch',
        steps: [],
        cancellable: true,
        startedAt: 1,
      },
    })
    expect((await api('/api/cloud/cancel', {})).status).toBe(202)
    expect(laptop.sent().at(-1)).toEqual({ type: 'cancel', id })
    expect(machine).not.toHaveBeenCalled()
  })

  it('admits a hello naming the relinked key on the replica it was relinked to', () => {
    const { instance, connect } = shared()
    connect().receive(hello())
    const renamed = connect()
    renamed.socket.serializeAttachment({ key: KEY, alias: 'github.com/hazat/renamed' })
    renamed.receive(hello({ key: 'github.com/hazat/renamed', machine: 'laptop' }))
    expect(renamed.sent()[0]).toMatchObject({ type: 'role', role: 'standby' })
    expect(instance.store.project()?.key).toBe(KEY)
    const other = connect()
    other.receive(hello({ key: 'github.com/hazat/renamed', machine: 'desk' }))
    expect(other.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, 'invalid hello')
  })

  it('refuses a claim with the wrong epoch, on a held lease, or from an unadmitted socket', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop' }))
    laptop.receive({ type: 'claim', epoch: 1 })
    expect(laptop.sent().at(-1)).toMatchObject({ role: 'standby', free: false, epoch: 1 })
    writer.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    for (const epoch of [0, 2]) {
      laptop.receive({ type: 'claim', epoch })
      expect(laptop.sent().at(-1)).toMatchObject({ role: 'standby', free: true, epoch: 1 })
    }
    const stranger = connect()
    stranger.receive({ type: 'claim', epoch: 1 })
    expect(stranger.socket.send).not.toHaveBeenCalled()
    expect(instance.store.lease()).toMatchObject({ machine: null, epoch: 1 })
    // The first valid claim wins; a second one at the same epoch is too late.
    const desk = connect()
    desk.receive(hello({ machine: 'desk' }))
    desk.receive({ type: 'claim', epoch: 1 })
    laptop.receive({ type: 'claim', epoch: 1 })
    expect(instance.store.lease()).toMatchObject({ machine: 'desk', epoch: 2 })
    expect(laptop.sent().at(-1)).toMatchObject({ role: 'standby', free: false, epoch: 2 })
  })

  it('keeps the lease with a disconnected writer, and fences it off once another machine claimed', () => {
    const { instance, connect, updates } = shared()
    const writer = connect()
    writer.receive(hello())
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop' }))
    writer.socket.readyState = WebSocket.CLOSED
    instance.webSocketClose(writer.machine)
    expect(instance.store.lease()).toMatchObject({ machine: 'test', epoch: 1 })
    expect(laptop.sent().at(-1)).toMatchObject({
      free: false,
      writer: { machine: 'test', online: false },
    })
    expect(updates.at(-1)?.writer).toEqual({
      machine: 'test',
      online: false,
      lastSeen: expect.any(Number),
    })
    laptop.receive({ type: 'claim', epoch: 1 })
    expect(instance.store.lease()?.machine).toBe('test')
    const back = connect()
    back.receive(hello({ epoch: 1 }))
    expect(back.sent()[0]).toMatchObject({ role: 'writer', epoch: 1 })
    back.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    laptop.receive({ type: 'claim', epoch: 1 })
    // The old writer returns with its old lease after the move: a standby.
    const stale = connect()
    stale.receive(hello({ epoch: 1 }))
    expect(stale.sent()).toEqual([
      expect.objectContaining({
        role: 'standby',
        epoch: 2,
        writer: expect.objectContaining({ machine: 'laptop' }),
      }),
    ])
    stale.receive({ type: 'batch', batch: 1, conversations: [], entries: [entry(1)], docs: [] })
    expect(instance.store.hasEntries()).toBe(false)
    expect(instance.sockets()).toEqual([laptop.machine])
  })

  it('closes a hello with another root commit without changing data or sending anything', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    writer.receive({
      type: 'batch',
      batch: 1,
      conversations: [conversation(1)],
      entries: [entry(1)],
      docs: [],
    })
    const before = [...instance.store.sql.exec('SELECT * FROM metadata ORDER BY 1')]
    const other = connect()
    other.receive(hello({ machine: 'laptop', rootCommit: 'b'.repeat(40) }))
    expect(other.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, 'root commit differs')
    expect(other.socket.send).not.toHaveBeenCalled()
    other.receive({ type: 'batch', batch: 1, conversations: [], entries: [entry(9)], docs: [] })
    expect(instance.store.cursor().entries).toEqual({ 1: 1 })
    expect([...instance.store.sql.exec('SELECT * FROM metadata ORDER BY 1')]).toEqual(before)
    expect(writer.socket.close).not.toHaveBeenCalled()
  })

  it.each([
    ['port 0', { port: 0 }],
    ['port 65536', { port: 65536 }],
    ['a fractional port', { port: 4800.5 }],
    ['a key other than the URL', { key: 'github.com/hazat/other' }],
    ['a malformed root commit', { rootCommit: 'HEAD' }],
    ['a relative root', { root: 'test' }],
    ['epoch 0', { epoch: 0 }],
    ['secret values', { secrets: [{ name: 'X', value: 'v' }] as unknown as string[] }],
  ])('refuses a hello with %s before admitting a socket', (_, overrides) => {
    const { instance, connect } = shared()
    const socket = connect()
    socket.receive(hello(overrides))
    expect(socket.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, 'invalid hello')
    expect(socket.socket.send).not.toHaveBeenCalled()
    expect(instance.store.project()).toBeUndefined()
  })

  it('records UI builds from hello and updates and reports them to the Directory', () => {
    const { instance, connect, updates } = shared()
    const writer = connect()
    writer.receive(hello({ uiBuild: '0123456789ab' }))
    expect(instance.store.lease()?.uiBuild).toBe('0123456789ab')
    writer.receive({ type: 'uiBuild', value: '1123456789ab' })
    expect(instance.store.lease()?.uiBuild).toBe('1123456789ab')
    const directory = new DirectoryStore(replica().sql)
    for (const update of updates) directory.update(update)
    expect(directory.resolve('test')?.uiBuild).toBe('1123456789ab')
    writer.receive({ type: 'uiBuild', value: '../invalid' })
    expect(instance.store.lease()?.uiBuild).toBe('1123456789ab')
    // A reconnect without a build keeps the last one.
    connect().receive(hello())
    expect(instance.store.lease()?.uiBuild).toBe('1123456789ab')
  })

  it('reports the first synced entries to the Directory and retains that fact on disconnect', () => {
    const { instance, connect, updates } = shared()
    const writer = connect()
    writer.receive(hello())
    expect(updates.at(-1)).toMatchObject({ hasEntries: false })
    writer.receive({ type: 'batch', batch: 1, conversations: [], entries: [entry(1)], docs: [] })
    expect(updates.at(-1)).toMatchObject({ hasEntries: true, writer: { online: true } })
    writer.receive({
      type: 'summaries',
      value: [{ id: 1, title: 'root', busy: false }],
      removed: [],
      full: true,
    })
    expect(updates.at(-1)).toMatchObject({ count: 1 })
    const calls = updates.length
    writer.receive({
      type: 'summaries',
      value: [{ id: 1, title: 'changed', busy: false }],
      removed: [],
      full: false,
    })
    expect(updates).toHaveLength(calls)
    instance.webSocketClose(writer.machine)
    expect(updates.at(-1)).toMatchObject({ hasEntries: true, writer: { online: false } })
  })

  it('restores socket roles from attachments after hibernation', () => {
    const sql = replica().sql
    const sockets: Socket[] = []
    const ctx = {
      id: { toString: () => '0123456789abcdef' },
      storage: { sql, transactionSync: <T>(run: () => T) => sql.transaction(run) },
      getWebSockets: () => sockets,
      waitUntil: vi.fn<() => void>(),
    } as unknown as ConstructorParameters<typeof SharedReplica>[0]
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const env = {
      DIRECTORY: {
        idFromName: () => 'directory',
        get: () => ({ fetch: async () => new Response() }),
      },
      MACHINE_ORIGIN: 'http://127.0.0.1:4800',
    } as unknown as ConstructorParameters<typeof SharedReplica>[1]
    let instance = new SharedReplica(ctx, env)
    const connect = () => {
      let attachment: unknown = { key: KEY }
      const socket = {
        readyState: WebSocket.OPEN,
        send: vi.fn<(data: string) => void>(),
        // A close has been requested, but its callback has not arrived yet.
        close: vi.fn<(code: number, reason: string) => void>(),
        serializeAttachment: (value: unknown) => {
          attachment = value
        },
        deserializeAttachment: () => attachment,
      }
      const machine = socket as unknown as Socket
      sockets.push(machine)
      return {
        socket,
        machine,
        receive: (message: MachineMessage) =>
          instance.webSocketMessage(machine, JSON.stringify(message)),
      }
    }
    const writer = connect()
    writer.receive(hello())
    const standby = connect()
    standby.receive(hello({ machine: 'laptop' }))
    connect()
    const { item } = instance.store.enqueue(1, 'queued before hibernation')
    writer.socket.send.mockClear()
    standby.socket.send.mockClear()

    // A fresh object has no sockets and logs nothing; a woken one reports what it still holds.
    expect(log).not.toHaveBeenCalled()
    const previous = instance
    instance = new SharedReplica(ctx, env)
    expect(log.mock.calls).toEqual([['Replica woke: object=01234567 sockets=3 admitted=2']])
    log.mockRestore()
    expect(instance.store).not.toBe(previous.store)
    expect(instance.sockets()).toEqual([writer.machine])
    const write: MachineMessage = {
      type: 'batch',
      batch: 2,
      conversations: [conversation(1)],
      entries: [entry(1)],
      docs: [doc(1)],
    }
    // No new hello: the restored writer socket must still be able to write.
    writer.receive(write)
    expect(instance.store.view(1)?.entries).toEqual([entry(1)])
    expect(writer.socket.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { type: 'ack', batch: 2 },
    ])
    const before = [...sql.exec('SELECT * FROM entries ORDER BY 1')]
    standby.receive({ ...write, entries: [entry(99)] })
    standby.receive({ type: 'delivered', id: item.id, submissionId: 1 })
    expect([...sql.exec('SELECT * FROM entries ORDER BY 1')]).toEqual(before)
    expect(instance.store.outbox()).toEqual([item])
    expect(standby.socket.send).not.toHaveBeenCalled()
    writer.receive({ type: 'delivered', id: item.id, submissionId: 1 })
    expect(instance.store.outbox()).toEqual([])
  })
})

describe('cloud replica', () => {
  it('lists one directory row per project with stable repository slugs, and forgets only offline projects without entries', () => {
    const directory = new DirectoryStore(replica().sql)
    const value: Presence = {
      key: 'github.com/hazat/ultimate',
      name: 'ultimate',
      writer: { machine: 'haza-pc', online: true },
      machines: [
        { machine: 'haza-pc', role: 'writer', connected: true, lastSeen: 100 },
        { machine: 'rog', role: 'standby', connected: false, lastSeen: 50 },
      ],
      count: 2,
      hasEntries: true,
    }
    directory.update(value)
    directory.update({ ...value, key: 'github.com/someone/ultimate' })
    directory.update({ ...value, key: 'github.com/hazat/poe2-rust', name: 'POE2 Rust' })
    expect(directory.list().map((row) => [row.slug, row.key])).toEqual([
      ['poe2-rust', 'github.com/hazat/poe2-rust'],
      ['ultimate', 'github.com/hazat/ultimate'],
      ['ultimate-2', 'github.com/someone/ultimate'],
    ])
    const { hasEntries: _, ...row } = value
    expect(directory.resolve('ultimate')).toEqual({ ...row, slug: 'ultimate' })
    const offline = {
      ...value,
      writer: { machine: 'haza-pc', online: false },
      machines: value.machines.map((machine) => ({ ...machine, connected: false })),
    }
    directory.update(offline)
    expect(directory.resolve('ultimate')).toMatchObject({ writer: { online: false }, count: 2 })
    directory.update({ ...value, count: 0, hasEntries: false })
    expect(directory.resolve('ultimate')).toMatchObject({ count: 0 })
    directory.update({ ...offline, count: 0, hasEntries: false })
    expect(directory.resolve('ultimate')).toBeUndefined()
    expect(directory.list()).toHaveLength(2)
    // The slug stays reserved for the returning project.
    directory.update(value)
    expect(directory.resolve('ultimate')?.key).toBe('github.com/hazat/ultimate')
  })

  it('applies full summaries and changed/removed deltas idempotently', () => {
    const store = replica()
    const first = { id: 1, title: 'first', busy: false },
      second = { id: 2, title: 'second', busy: false }
    store.receive({ type: 'summaries', value: [first, second], removed: [], full: true })
    const delta: MachineMessage = {
      type: 'summaries',
      value: [{ ...second, busy: true }],
      removed: [1],
      full: false,
    }
    store.receive(delta)
    store.receive(delta)
    expect(store.summaries()).toEqual([{ ...second, busy: true }])
    store.receive({ type: 'summaries', value: [], removed: [], full: true })
    expect(store.summaries()).toEqual([])
  })

  it.each([0, -1, 65536, 4800.5])('never proxies an invalid port %s', async (port) => {
    const instance = worker(true)
    instance.store.hello(hello({ port }), true)
    const forward = vi.fn<() => void>()
    vi.stubGlobal('fetch', forward)
    expect((await instance.fetch(new Request('https://cloud.example/api/models'))).status).toBe(200)
    expect(forward).not.toHaveBeenCalled()
  })

  it('stays offline without a binding for its machine', async () => {
    const instance = worker(true)
    const forward = vi.fn<() => void>()
    Object.assign(instance, {
      env: { TUNNELS: JSON.stringify({ other: 'TUNNEL_0' }), TUNNEL_0: { fetch: forward } },
    })
    expect((await instance.fetch(new Request('https://cloud.example/api/models'))).status).toBe(200)
    expect(forward).not.toHaveBeenCalled()
  })

  it('applies a batch twice idempotently, returns its ack and cursor hashes, and retires docs', () => {
    const store = replica()
    batch(store, [entry(1), entry(2)], [doc(3)])
    expect(batch(store, [entry(1), entry(2)], [doc(3)])).toEqual([{ type: 'ack', batch: 1 }])
    expect(store.view(1)?.entries.map((record) => record.id)).toEqual([1, 2])
    expect(store.hello(hello(), false)?.slice(1)).toEqual([
      { type: 'cursor', entries: { 1: 2 }, docs: { 3: 'hash-3' } },
      { type: 'outbox', items: [] },
    ])
    batch(store, [], [{ ...doc(3), value: null }])
    expect(store.cursor().docs).toEqual({})
    expect(store.view(1)?.docs['pi.agent']).toBeUndefined()
  })
  it('resumes each conversation from its own newest entry, without inheriting a parent cursor', () => {
    const store = replica()
    expect(store.cursor().entries).toEqual({})
    batch(
      store,
      [entry(1), entry(3), entry(2, 2)],
      [],
      [conversation(1), conversation(2), conversation(3, { conversationId: 1, at: 3 })],
    )
    expect(store.cursor().entries).toEqual({ 1: 3, 2: 2 })
    batch(store, [entry(4, 2)], [], [conversation(2)])
    expect(store.cursor().entries).toEqual({ 1: 3, 2: 4 })
  })
  it('rolls a failing batch back atomically', () => {
    const store = replica()
    batch(store, [entry(1)])
    const bad = { ...entry(3), data: 1n } as unknown as EntryRecord
    expect(() => batch(store, [entry(2), bad])).toThrow(/BigInt/)
    expect(store.cursor().entries).toEqual({ 1: 1 })
  })
  it('reconstructs plain views, drops live docs and keeps extension docs outside the view', () => {
    const store = replica()
    batch(store, [entry(1), entry(2)], [doc(1), doc(2, 'pi.live'), doc(3, 'ultimate.ui')])
    expect(store.view(1)).toEqual({
      conversation: { id: 1 },
      entries: [entry(1), entry(2)],
      docs: { 'pi.agent': { test: true }, 'pi.inbox': { items: [] } },
    })
    expect(store.doc(1, 'ultimate.ui')).toEqual({ test: true })
    expect(store.view(99)).toBeNull()
  })
  it('uses the latest head marker and active non-head entries', () => {
    const store = replica()
    batch(store, [entry(1), entry(2, 1, 1), entry(3), entry(4, 1, 3), entry(5)])
    expect(store.view(1)?.entries.map((record) => record.id)).toEqual([4, 3, 5])
  })
  it('inherits recursively only through each fork point, not later parent entries', () => {
    const store = replica()
    batch(
      store,
      [entry(1), entry(2), entry(3, 2), entry(4), entry(5, 2), entry(6, 3)],
      [],
      [
        conversation(1),
        conversation(2, { conversationId: 1, at: 2 }),
        conversation(3, { conversationId: 2, at: 3 }),
      ],
    )
    expect(store.view(2)?.entries.map((record) => record.id)).toEqual([1, 2, 3, 5])
    expect(store.view(3)?.entries.map((record) => record.id)).toEqual([1, 2, 3, 6])
  })
  it('caps every ancestor by the descendant bound and excludes later head markers', () => {
    const store = replica()
    batch(
      store,
      [entry(1), entry(2), entry(3, 1, 3), entry(4, 2), entry(5, 2, 5), entry(6, 3)],
      [],
      [
        conversation(1),
        conversation(2, { conversationId: 1, at: 3 }),
        conversation(3, { conversationId: 2, at: 2 }),
      ],
    )
    expect(store.view(3)?.entries).toEqual([entry(1), entry(2), entry(6, 3)])
    expect(store.history(3, 7).entries).toEqual([entry(6, 3), entry(2), entry(1)])
  })
  it('pages history newest first across the 64 boundary', () => {
    const store = replica()
    batch(
      store,
      Array.from({ length: 130 }, (_, index) => entry(index + 1)),
    )
    const first = store.history(1, 131)
    expect(first.entries).toHaveLength(64)
    expect(first.entries[0].id).toBe(130)
    expect(first.before).toBe(67)
    const second = store.history(1, first.before!)
    expect(second.before).toBe(3)
    expect(store.history(1, second.before!)).toEqual({ entries: [entry(2), entry(1)] })
  })
  it('keeps an outbox, exposes numeric queue IDs in pi.inbox, and deletes only on delivery', () => {
    const store = replica()
    batch(
      store,
      [],
      [
        {
          ...doc(1, 'pi.inbox'),
          value: { items: [{ id: 10, mode: 'steer', content: 'already queued' }] },
        },
      ],
    )
    const { item, submissionId } = store.enqueue(1, 'offline prompt', 'steer')
    expect(submissionId).toBeLessThan(0)
    expect(store.outbox()).toEqual([item])
    expect(store.view(1)?.docs['pi.inbox']).toEqual({
      items: [
        { id: 10, mode: 'steer', content: 'already queued' },
        { id: submissionId, mode: 'steer', content: 'offline prompt' },
      ],
    })
    expect(store.hello(hello(), false)?.[2]).toEqual({ type: 'outbox', items: [item] })
    store.receive({ type: 'delivered', id: item.id, submissionId: 12 })
    store.receive({ type: 'delivered', id: item.id, submissionId: 12 })
    expect(store.outbox()).toEqual([])
    expect(store.view(1)?.docs['pi.inbox'].items).toHaveLength(1)
  })
  it('bounds reads to the requested conversation, active range and history page', () => {
    let rows = 0
    const store = replica((count) => {
      rows += count
    })
    batch(
      store,
      [entry(1), entry(2), ...Array.from({ length: 5000 }, (_, index) => entry(index + 3, 2))],
      [
        doc(1),
        ...Array.from({ length: 5000 }, (_, index) => ({ ...doc(index + 2), conversationId: 2 })),
      ],
      [conversation(1), conversation(2)],
    )
    for (let index = 0; index < 5000; index++) store.enqueue(2, `unrelated ${index}`)
    store.enqueue(1, 'own queued input')
    rows = 0
    expect(store.view(1)?.entries).toEqual([entry(1), entry(2)])
    expect(rows).toBeLessThan(12)
    rows = 0
    expect(store.history(1, 5003)).toEqual({ entries: [entry(2), entry(1)] })
    expect(rows).toBeLessThan(8)
    rows = 0
    expect(store.doc(1, 'pi.agent')).toEqual({ test: true })
    expect(rows).toBe(1)

    // A large related conversation must not load its cut history to build an active view.
    batch(
      store,
      [
        ...Array.from({ length: 5000 }, (_, index) => entry(index + 5003, 3)),
        entry(10003, 3, 10003),
        entry(10004, 3),
      ],
      [],
      [conversation(3)],
    )
    rows = 0
    expect(store.view(3)?.entries.map((record) => record.id)).toEqual([10003, 10004])
    expect(rows).toBeLessThan(8)
    rows = 0
    expect(store.history(3, 10005).entries).toHaveLength(64)
    expect(rows).toBeLessThan(70)

    batch(
      store,
      [entry(10005, 4, 10005), entry(10006, 4)],
      [],
      [conversation(4, { conversationId: 2, at: 5002 })],
    )
    rows = 0
    expect(store.view(4)?.entries.map((record) => record.id)).toEqual([10005, 10006])
    expect(rows).toBeLessThan(10)
    const plan = [
      ...store.sql.exec<{ detail: string }>(
        'EXPLAIN QUERY PLAN SELECT value FROM entries WHERE conversation_id=? AND id<=? AND head IS NOT NULL ORDER BY id DESC LIMIT 1',
        2,
        5002,
      ),
    ]
    expect(plan.map((row) => row.detail).join(' ')).toContain('entry_heads_conversation')
  })
  it('delivers and displays outbox items in insertion order rather than UUID order', () => {
    const store = replica()
    batch(store)
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('ffffffff-ffff-ffff-ffff-ffffffffffff')
      .mockReturnValueOnce('88888888-8888-8888-8888-888888888888')
      .mockReturnValueOnce('00000000-0000-0000-0000-000000000000')
    for (const text of ['first', 'second', 'third']) store.enqueue(1, text)
    expect(store.outbox().map((item) => item.text)).toEqual(['first', 'second', 'third'])
    expect(store.view(1)?.docs['pi.inbox'].items).toEqual([
      { id: -1, mode: 'followUp', content: 'first' },
      { id: -2, mode: 'followUp', content: 'second' },
      { id: -3, mode: 'followUp', content: 'third' },
    ])
  })
  it('stores the latest metadata', () => {
    const store = replica()
    store.receive({ type: 'models', value: { models: [] } })
    store.receive({ type: 'models', value: { models: ['updated'] } })
    expect(store.metadata(3)).toEqual({ models: ['updated'] })
  })
  it('rewrites proxy admission headers and preserves method, query and body', async () => {
    const request = new Request('https://cloud.example/api/extensions/test/actions/run?x=1', {
      method: 'POST',
      headers: {
        Origin: 'https://cloud.example',
        'CF-Connecting-IP': '1.2.3.4',
        Forwarded: 'for=1.2.3.4',
        'X-Forwarded-Host': 'cloud.example',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: '{"args":1}',
    })
    const proxied = proxyRequest(request, 'http://127.0.0.1:4800')
    expect(proxied.url).toBe('http://127.0.0.1:4800/api/extensions/test/actions/run?x=1')
    expect(proxied.headers.get('Host')).toBe('127.0.0.1:4800')
    expect(proxied.headers.get('Origin')).toBe('http://127.0.0.1:4800')
    expect([...proxied.headers.keys()]).toEqual(['content-type', 'host', 'origin'])
    expect(proxied.method).toBe('POST')
    expect(await proxied.text()).toBe('{"args":1}')
  })
})
