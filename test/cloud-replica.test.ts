import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectReplica } from '../cloud/worker.ts'
import type { ConversationRecord, EntryRecord } from '@earendil-works/pi-durable'
import { ReplicaStore, proxyRequest } from '../cloud/replica.ts'
import type { Sql } from '../cloud/replica.ts'
import { DirectoryStore } from '../cloud/directory.ts'
import { PROJECT_MISMATCH } from '../cloud/protocol.ts'
import type { MachineMessage, ReplicaDoc } from '../cloud/protocol.ts'

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
function worker(online = false) {
  const instance = Object.assign(Object.create(ProjectReplica.prototype) as ProjectReplica, {
    store: replica(),
    streams: new Set(),
    env: { MACHINE_ORIGIN: 'http://127.0.0.1:4800' },
  })
  instance.store.receive(hello('/test'))
  vi.spyOn(instance, 'sockets').mockReturnValue(
    online
      ? [{ send: vi.fn<() => void>() } as unknown as ReturnType<ProjectReplica['sockets']>[number]]
      : [],
  )
  return instance
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
    deserializeAttachment: () => true,
  } as unknown as Parameters<ProjectReplica['webSocketMessage']>[0]
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

const hello = (project: string): MachineMessage => ({
  type: 'hello',
  machine: 'test',
  port: 4800,
  build: 'test',
  project,
})

describe('cloud replica', () => {
  it('records UI builds from hello and updates and reports them to the Directory', async () => {
    const instance = worker()
    const directory = new DirectoryStore(replica().sql)
    const socket = { readyState: WebSocket.OPEN, deserializeAttachment: () => true, send() {} }
    const pending: Promise<unknown>[] = []
    Object.assign(instance, {
      ctx: {
        getWebSockets: () => [socket],
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      },
      env: {
        DIRECTORY: {
          idFromName: () => 'directory',
          get: () => ({
            fetch: async (_url: string, init: RequestInit) => {
              directory.update(JSON.parse(init.body as string))
              return new Response()
            },
          }),
        },
      },
    })
    instance.store.receive({ ...hello('/test'), uiBuild: '0123456789ab' } as MachineMessage)
    expect(instance.store.identity()?.uiBuild).toBe('0123456789ab')
    instance.webSocketMessage(
      socket as unknown as Parameters<ProjectReplica['webSocketMessage']>[0],
      JSON.stringify({ type: 'uiBuild', value: '1123456789ab' }),
    )
    await Promise.all(pending)
    expect(instance.store.identity()?.uiBuild).toBe('1123456789ab')
    expect(directory.resolve('test/test')?.uiBuild).toBe('1123456789ab')
    instance.store.receive({ type: 'uiBuild', value: '../invalid' })
    expect(instance.store.identity()?.uiBuild).toBe('1123456789ab')
  })
  it('assigns stable safe slugs, resolves collisions, and forgets only offline projects without entries', () => {
    const directory = new DirectoryStore(replica().sql)
    const value = {
      machine: 'Desk PC',
      project: '/work/My App',
      port: 4801,
      connected: true,
      lastSeen: 100,
      count: 2,
      hasEntries: true,
    }
    directory.update(value)
    directory.update({ ...value, project: '/other/My App' })
    expect(directory.list().map((row) => row.slug)).toEqual(['desk-pc/my-app', 'desk-pc/my-app-2'])
    directory.update({ ...value, connected: false, lastSeen: 200 })
    expect(directory.resolve('desk-pc/my-app')).toMatchObject({
      connected: false,
      lastSeen: 200,
      count: 2,
    })
    directory.update({ ...value, count: 0, hasEntries: false })
    expect(directory.resolve('desk-pc/my-app')).toMatchObject({ connected: true, count: 0 })
    directory.update({ ...value, count: 0, connected: false, hasEntries: false })
    expect(directory.resolve('desk-pc/my-app')).toBeUndefined()
    expect(directory.list()).toHaveLength(1)
    directory.update(value)
    expect(directory.resolve('desk-pc/my-app')).toMatchObject(value)
  })

  it('reports the first synced entries to the Directory and retains that fact on disconnect', () => {
    const instance = worker()
    const update = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(),
    )
    Object.assign(instance, {
      env: { DIRECTORY: { idFromName: () => 'directory', get: () => ({ fetch: update }) } },
    })
    const socket = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => true,
      send: vi.fn<(value: string) => void>(),
      close: vi.fn<() => void>(),
    }
    Object.assign(instance, {
      ctx: {
        getWebSockets: () => [socket],
        waitUntil: vi.fn<(promise: Promise<unknown>) => void>(),
      },
    })
    expect(instance.store.hasEntries()).toBe(false)
    instance.webSocketMessage(
      socket as unknown as ReturnType<ProjectReplica['sockets']>[number],
      JSON.stringify({ type: 'batch', batch: 1, conversations: [], entries: [entry(1)], docs: [] }),
    )
    expect(JSON.parse(update.mock.calls.at(-1)![1].body as string)).toMatchObject({
      hasEntries: true,
      connected: true,
    })
    instance.webSocketClose(socket as unknown as ReturnType<ProjectReplica['sockets']>[number])
    expect(JSON.parse(update.mock.calls.at(-1)![1].body as string)).toMatchObject({
      hasEntries: true,
      connected: false,
    })
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
    instance.store.receive({ ...hello('/test'), port } as MachineMessage)
    const forward = vi.fn<() => void>()
    vi.stubGlobal('fetch', forward)
    expect((await instance.fetch(new Request('https://cloud.example/api/models'))).status).toBe(200)
    expect(forward).not.toHaveBeenCalled()
  })

  it.each([0, 65536, 4800.5])('refuses hello port %s before admitting a socket', (port) => {
    const instance = worker()
    instance.store.claimKey('test', '/test')
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn<(value: string) => void>(),
      close: vi.fn<(code: number, reason: string) => void>(),
    }
    Object.assign(instance, { ctx: { getWebSockets: () => [socket] } })
    instance.webSocketMessage(
      socket as unknown as ReturnType<ProjectReplica['sockets']>[number],
      JSON.stringify({ ...hello('/test'), port }),
    )
    expect(socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, 'Machine or project mismatch')
    expect(socket.send).not.toHaveBeenCalled()
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

  it('rejects a second project without changing data or sending a cursor, and accepts the same project again', () => {
    const sockets: ReturnType<ProjectReplica['sockets']> = []
    const instance = Object.assign(Object.create(ProjectReplica.prototype) as ProjectReplica, {
      store: replica(),
      streams: new Set(),
      ctx: { getWebSockets: () => sockets, waitUntil: vi.fn<() => void>() },
      env: {
        DIRECTORY: {
          idFromName: () => 'directory',
          get: () => ({ fetch: async () => new Response() }),
        },
      },
    })
    instance.store.claimKey('test', '/ultimate')
    const connect = () => {
      let attachment: unknown
      const socket = {
        readyState: WebSocket.OPEN as number,
        send: vi.fn<(data: string) => void>(),
        close: vi.fn<(code: number, reason: string) => void>(() => {
          socket.readyState = WebSocket.CLOSED
        }),
        serializeAttachment: (value: unknown) => {
          attachment = value
        },
        deserializeAttachment: () => attachment,
      }
      sockets.push(socket as unknown as (typeof sockets)[number])
      const receive = (message: MachineMessage) =>
        instance.webSocketMessage(
          socket as unknown as (typeof sockets)[number],
          JSON.stringify(message),
        )
      return { socket, receive }
    }
    const update = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(),
    )
    instance.env.DIRECTORY.get = vi.fn<() => { fetch: typeof update }>(() => ({
      fetch: update,
    })) as unknown as typeof instance.env.DIRECTORY.get
    // The sync route binds this object before hello; wrong machine must not adopt it.
    const wrong = connect()
    wrong.receive({ ...hello('/ultimate'), machine: 'other' } as MachineMessage)
    expect(wrong.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, 'Machine or project mismatch')
    expect(instance.store.metadata(4)).toBeUndefined()
    // Existing dry-run data has no project yet; the first hello adopts it without changing it.
    batch(instance.store, [entry(1)], [doc(1)])
    instance.store.enqueue(1, 'queued')
    const first = connect()
    first.receive({
      type: 'batch',
      batch: 1,
      conversations: [conversation(99)],
      entries: [],
      docs: [],
    })
    expect(instance.store.conversation(99)).toBeUndefined()
    expect(first.socket.send).not.toHaveBeenCalled()
    expect(instance.sockets()).toEqual([])
    first.receive(hello('/ultimate'))
    expect(first.socket.send.mock.calls.map(([data]) => JSON.parse(data).type)).toEqual([
      'cursor',
      'outbox',
    ])
    expect(instance.store.metadata(4)).toBe('/ultimate')
    expect(JSON.parse(update.mock.calls[0][1].body as string)).toMatchObject({
      machine: 'test',
      project: '/ultimate',
      port: 4800,
      connected: true,
    })
    first.receive({
      type: 'summaries',
      value: [{ id: 1, title: 'root', busy: false }],
      removed: [],
      full: true,
    })
    expect(JSON.parse(update.mock.calls.at(-1)![1].body as string)).toMatchObject({
      count: 1,
      connected: true,
    })
    const calls = update.mock.calls.length
    first.receive({
      type: 'summaries',
      value: [{ id: 1, title: 'changed', busy: false }],
      removed: [],
      full: false,
    })
    expect(update).toHaveBeenCalledTimes(calls)
    const snapshot = () =>
      ['metadata', 'conversations', 'entries', 'docs', 'outbox', 'summaries'].map((table) => [
        ...instance.store.sql.exec(`SELECT * FROM ${table} ORDER BY 1`),
      ])
    const before = snapshot()
    // Reopening the store over the same database must preserve the project guard.
    Object.assign(instance, { store: new ReplicaStore(instance.store.sql) })
    const second = connect()
    second.receive(hello('/poe2-rust'))
    expect(second.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, '/ultimate')
    expect(second.socket.send).not.toHaveBeenCalled()
    second.receive({
      type: 'batch',
      batch: 1,
      conversations: [conversation(99)],
      entries: [entry(2)],
      docs: [],
    })
    expect(snapshot()).toEqual(before)
    expect(first.socket.close).not.toHaveBeenCalled()
    const reconnect = connect()
    reconnect.receive(hello('/ultimate'))
    expect(reconnect.socket.close).not.toHaveBeenCalled()
    expect(reconnect.socket.send.mock.calls.map(([data]) => JSON.parse(data).type)).toEqual([
      'cursor',
      'outbox',
    ])
    expect(first.socket.close).toHaveBeenCalledWith(1000, 'Replaced by new machine connection')
    instance.webSocketClose(reconnect.socket as unknown as (typeof sockets)[number])
    expect(JSON.parse(update.mock.calls.at(-1)![1].body as string)).toMatchObject({
      connected: false,
      project: '/ultimate',
    })
  })

  it('restores socket admission from attachments after hibernation', () => {
    const sql = replica().sql
    const sockets: ReturnType<ProjectReplica['sockets']> = []
    const ctx = {
      id: { toString: () => '0123456789abcdef' },
      storage: { sql, transactionSync: <T>(run: () => T) => sql.transaction(run) },
      getWebSockets: () => sockets,
      waitUntil: vi.fn<() => void>(),
    } as unknown as ConstructorParameters<typeof ProjectReplica>[0]
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const env = {
      DIRECTORY: {
        idFromName: () => 'directory',
        get: () => ({ fetch: async () => new Response() }),
      },
      MACHINE_ORIGIN: 'http://127.0.0.1:4800',
    } as unknown as ConstructorParameters<typeof ProjectReplica>[1]
    let instance = new ProjectReplica(ctx, env)
    instance.store.claimKey('test', '/ultimate')
    const connect = () => {
      let attachment: unknown
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
      const machine = socket as unknown as (typeof sockets)[number]
      sockets.push(machine)
      return {
        socket,
        machine,
        receive: (message: MachineMessage) =>
          instance.webSocketMessage(machine, JSON.stringify(message)),
      }
    }
    const accepted = connect()
    accepted.receive(hello('/ultimate'))
    const refused = connect()
    refused.receive(hello('/poe2-rust'))
    expect(refused.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, '/ultimate')
    expect(accepted.socket.deserializeAttachment()).toBe(true)
    expect(refused.socket.deserializeAttachment()).not.toBe(true)
    const { item } = instance.store.enqueue(1, 'queued before hibernation')
    accepted.socket.send.mockClear()

    // A fresh object has no sockets and logs nothing; a woken one reports what it still holds.
    expect(log).not.toHaveBeenCalled()
    const previous = instance
    instance = new ProjectReplica(ctx, env)
    expect(log.mock.calls).toEqual([['Replica woke: object=01234567 sockets=2 admitted=1']])
    log.mockRestore()
    expect(instance).not.toBe(previous)
    expect(instance.store).not.toBe(previous.store)
    expect(instance.sockets()).toEqual([accepted.machine])
    const write: MachineMessage = {
      type: 'batch',
      batch: 2,
      conversations: [conversation(1)],
      entries: [entry(1)],
      docs: [doc(1)],
    }
    // No new hello: the restored accepted socket must still be able to write.
    accepted.receive(write)
    expect(instance.store.view(1)?.entries).toEqual([entry(1)])
    expect(accepted.socket.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { type: 'ack', batch: 2 },
    ])
    const snapshot = () =>
      ['metadata', 'conversations', 'entries', 'docs', 'outbox'].map((table) => [
        ...sql.exec(`SELECT * FROM ${table} ORDER BY 1`),
      ])
    const before = snapshot()
    refused.receive({ ...write, entries: [entry(99)] })
    refused.receive({ type: 'summaries', value: [], removed: [], full: true })
    refused.receive({ type: 'delivered', id: item.id, submissionId: 1 })
    expect(snapshot()).toEqual(before)
    expect(refused.socket.send).not.toHaveBeenCalled()
    expect(accepted.socket.close).not.toHaveBeenCalled()
    accepted.receive({ type: 'delivered', id: item.id, submissionId: 1 })
    expect(instance.store.outbox()).toEqual([])
    const next = instance.store.enqueue(1, 'queued after hibernation').item
    accepted.receive(hello('/ultimate'))
    expect(accepted.socket.send.mock.calls.map(([data]) => JSON.parse(data))).toContainEqual({
      type: 'outbox',
      items: [next],
    })
    const other = connect()
    other.receive(hello('/another-project'))
    expect(other.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, '/ultimate')
    expect(other.socket.send).not.toHaveBeenCalled()
    expect(instance.sockets()).toEqual([accepted.machine])
    expect(accepted.socket.close).not.toHaveBeenCalled()
  })

  it('truncates a mismatched project reason on a UTF-8 boundary within 123 bytes', () => {
    const instance = worker()
    const held = '/projects/' + '🦀'.repeat(40)
    instance.store.claimProject(held)
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn<(data: string) => void>(),
      close: vi.fn<(code: number, reason: string) => void>(),
    }
    Object.assign(instance, { ctx: { getWebSockets: () => [socket] } })
    instance.webSocketMessage(
      socket as unknown as ReturnType<ProjectReplica['sockets']>[number],
      JSON.stringify({
        type: 'hello',
        machine: 'test',
        build: 'test',
        port: 4800,
        project: '/other',
      }),
    )
    const [code, reason] = socket.close.mock.calls[0]
    expect(code).toBe(PROJECT_MISMATCH)
    expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(123)
    expect(reason).toBe('/projects/' + '🦀'.repeat(28))
    expect(socket.send).not.toHaveBeenCalled()
    expect(instance.store.metadata(4)).toBe(held)
  })
  it('applies a batch twice idempotently, returns its ack and cursor hashes, and retires docs', () => {
    const store = replica()
    batch(store, [entry(1), entry(2)], [doc(3)])
    expect(batch(store, [entry(1), entry(2)], [doc(3)])).toEqual([{ type: 'ack', batch: 1 }])
    expect(store.view(1)?.entries.map((record) => record.id)).toEqual([1, 2])
    expect(
      store.receive({
        type: 'hello',
        machine: 'test',
        build: 'test',
        port: 4800,
        project: '/test',
      }),
    ).toEqual([
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
    expect(
      store.receive({
        type: 'hello',
        machine: 'test',
        build: 'test',
        port: 4800,
        project: '/test',
      })[1],
    ).toEqual({
      type: 'outbox',
      items: [item],
    })
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
