import { timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import cloudWorker, { SharedReplica } from '../cloud/worker.ts'
import { ReplicaStore, RETIRED_TABLES } from '../cloud/replica.ts'
import type { Sql } from '../cloud/replica.ts'
import { DirectoryStore } from '../cloud/directory.ts'
import type { Presence } from '../cloud/directory.ts'
import { PROJECT_MISMATCH } from '../cloud/protocol.ts'
import type { CloudMessage, Hello, MachineMessage, Transition } from '../cloud/protocol.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function database() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql: Sql = {
    exec: <T extends Record<string, unknown>>(
      query: string,
      ...bindings: (string | number | null)[]
    ) => {
      const statement = db.prepare(query)
      if (statement.columns().length) return statement.all(...bindings) as T[]
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
  return sql
}
const replica = () => new ReplicaStore(database())
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
  secretsComplete: true,
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
/** A replica with fake sockets that records what it reports to the Directory. */
function shared() {
  const sockets: Socket[] = []
  const updates: Presence[] = []
  const instance = Object.assign(Object.create(SharedReplica.prototype) as SharedReplica, {
    store: replica(),
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
it.each([
  ['{"type":"secrets","private":"do not log 🐈"}', 'secrets'],
  ['{"type":"do not log","private":"do not log"}', 'unknown'],
  ['{"private":"do not log"', 'unknown'],
])('logs only message type and byte size on WebSocket exceptions: %s', (raw, type) => {
  const { instance } = shared()
  const error = new Error('private exception detail')
  // Any failure after parsing: reading the socket's attachment stands in for one.
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => {
      throw error
    },
  } as unknown as Socket
  Object.assign(instance, { ctx: { getWebSockets: () => [socket] } })
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
})

it('drops the retired conversation copy on wake and keeps the lease, machines and transition', () => {
  const sql = database()
  const before = new ReplicaStore(sql)
  before.hello(hello({ secrets: ['A'] }), false)
  before.report('test', { ...running('move-1'), target: 'test' })
  const lease = before.lease()
  // What the conversation copy left behind: its tables full, system info and models in metadata.
  for (const table of RETIRED_TABLES) {
    sql.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`)
    sql.exec(`INSERT INTO ${table} (id, value) VALUES (1, 'old')`)
  }
  for (const id of [2, 3]) sql.exec('INSERT INTO metadata (id, value) VALUES (?, ?)', id, '{}')

  const woken = new ReplicaStore(sql)
  const tables = [
    ...sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1"),
  ].map((row) => row.name)
  expect(tables).toEqual(['metadata'])
  expect([...sql.exec<{ id: number }>('SELECT id FROM metadata ORDER BY id')]).toEqual([
    { id: 4 },
    { id: 5 },
    { id: 6 },
    { id: 7 },
  ])
  expect(woken.lease()).toEqual(lease)
  expect(lease).toMatchObject({ machine: 'test', epoch: 1, secrets: ['A'] })
  expect(woken.machines()).toEqual(before.machines())
  expect(woken.transition()?.id).toBe('move-1')
  // Waking again finds nothing to drop.
  expect(() => new ReplicaStore(sql)).not.toThrow()
})

const types = (messages: CloudMessage[]) => messages.map((message) => message.type)

it('records the writer’s backup for the directory without touching the lease, and ignores a standby’s', () => {
  const { connect, updates, instance } = shared()
  const desk = connect()
  desk.receive(hello({ machine: 'desk' }))
  const laptop = connect()
  laptop.receive(hello({ machine: 'laptop', root: '/other', lastBackupAt: 3 }))
  const lease = structuredClone(instance.store.lease())
  laptop.receive({ type: 'backup', at: 4 })
  expect(instance.store.lastBackupAt()).toBeUndefined()
  desk.receive({ type: 'backup', at: 0 })
  expect(instance.store.lastBackupAt()).toBeUndefined()
  desk.receive({ type: 'backup', at: 7 })
  expect(instance.store.lastBackupAt()).toBe(7)
  expect(updates.at(-1)?.lastBackupAt).toBe(7)
  expect(instance.store.lease()).toEqual(lease)
  // A hello without one keeps the recorded time; a hello with one replaces it.
  desk.receive(hello({ machine: 'desk' }))
  expect(instance.store.lastBackupAt()).toBe(7)
  desk.receive(hello({ machine: 'desk', lastBackupAt: 9 }))
  expect(instance.store.lastBackupAt()).toBe(9)
})

describe('project replica sockets', () => {
  it('registers an unknown project with its first machine as writer at epoch 1', () => {
    const { instance, connect, updates } = shared()
    const first = connect()
    first.receive(hello({ secrets: ['OPENAI_API_KEY'] }))
    expect(first.sent()).toEqual([
      {
        type: 'role',
        role: 'writer',
        project: { key: KEY },
        epoch: 1,
        free: false,
        writer: {
          machine: 'test',
          root: '/test',
          epoch: 1,
          online: true,
          secrets: ['OPENAI_API_KEY'],
          secretsComplete: true,
        },
      },
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
    })
    expect(updates.at(-1)).not.toHaveProperty('count')
  })

  it('makes a second machine a standby whose lease messages are ignored, and tells it when the writer comes and goes', () => {
    const { instance, connect, updates } = shared()
    const writer = connect()
    writer.receive(hello({ secrets: ['GITHUB_TOKEN'] }))
    const standby = connect()
    standby.receive(hello({ machine: 'laptop', root: '/home/me/test', history: true }))
    expect(standby.sent()).toEqual([
      {
        type: 'role',
        role: 'standby',
        project: { key: KEY },
        epoch: 1,
        free: false,
        writer: {
          machine: 'test',
          root: '/test',
          epoch: 1,
          online: true,
          secrets: ['GITHUB_TOKEN'],
          secretsComplete: true,
        },
      },
    ])
    const snapshot = () => [...instance.store.sql.exec('SELECT * FROM metadata ORDER BY 1')]
    const before = snapshot()
    standby.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    standby.receive({ type: 'release-waiting', by: 'laptop', tasks: 1 })
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
    expect(types(back.sent())).toEqual(['role'])
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
    expect(types(reinstalled.sent())).toEqual(['role'])
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
      project: { key: KEY },
      epoch: 1,
      free: true,
      snapshot: { id: 'snap-1', epoch: 1 },
      writer: {
        machine: null,
        root: '/test',
        epoch: 1,
        online: false,
        secrets: [],
        secretsComplete: true,
      },
    }
    expect(writer.sent().at(-1)).toEqual(free)
    expect(laptop.sent().at(-1)).toEqual(free)
    expect(instance.sockets()).toEqual([])
    expect(updates.at(-1)?.writer).toEqual({ machine: null, online: false })
    // The released socket is a standby now: its lease messages are ignored.
    writer.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-2' } })
    expect(instance.store.lease()?.snapshot).toEqual({ id: 'snap-1', epoch: 1 })

    laptop.receive({ type: 'claim', epoch: 1 })
    expect(laptop.sent().slice(-1)).toEqual([
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
          secretsComplete: true,
        },
      },
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
      by: 'cloud',
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
    // Who started it is one of the four initiators, or absent from a machine that predates it.
    laptop.receive({ type: 'transition', value: { ...transition, by: 'someone' } as never })
    expect(instance.store.transition()).toBeUndefined()
    const { by: _by, ...unattributed } = transition
    laptop.receive({ type: 'transition', value: unattributed })
    expect(instance.store.transition()).toEqual(unattributed)
    laptop.receive({ type: 'transition', value: transition })
    expect(instance.store.transition()?.by).toBe('cloud')
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

  it('lists machines, lease and transition, forwards moves and cancels to the target, and answers nothing else', async () => {
    const { instance, connect } = shared()
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
    // The conversation copy and the live proxy are gone: any other path is a 404.
    for (const path of ['/api/models', '/api/events', '/api/conversations/1/history?before=2'])
      expect((await api(path)).status).toBe(404)
    expect((await api('/api/conversations/1/submit', { text: 'x' })).status).toBe(404)
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
    const moved = await api('/sync/move', { machine: 'laptop', force: true })
    expect(moved.status).toBe(202)
    const { id } = (await moved.json()) as { id: string }
    expect(laptop.sent().at(-1)).toEqual({ type: 'move-to', id, by: 'sync', force: true })
    // The cloud UI's move route is gone with the UI.
    expect((await api('/api/cloud/move', { machine: 'laptop' })).status).toBe(404)
    for (const [body, error] of [
      [{ machine: 'test' }, 'runs there already'],
      [{ machine: 'desk' }, 'not connected'],
    ] as const) {
      const refused = await api('/sync/move', body)
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
  })

  it('answers agents with the sync token on /sync/directory, /sync/cloud, /sync/move and /sync/cancel', async () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello({ secrets: ['A', 'B'] }))
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop', root: '/laptop', secrets: ['A'] }))
    const replicas: string[] = []
    const listed = vi.fn<() => Response>(() => Response.json([{ key: KEY }]))
    const env = {
      SYNC_TOKEN: 'synthetic-test-value',
      REPLICA: {
        idFromName: (name: string) => name,
        get: (name: string) => {
          replicas.push(name)
          return instance
        },
      },
      DIRECTORY: {
        idFromName: () => 'directory',
        get: () => ({
          fetch: async (url: string) => {
            const { pathname, searchParams } = new URL(url)
            if (pathname === '/list') return listed()
            // The renamed key was relinked to this project's replica.
            return searchParams.get('key') === 'github.com/hazat/renamed'
              ? Response.json({ target: KEY })
              : new Response(null, { status: 404 })
          },
        }),
      },
    } as unknown as Parameters<typeof cloudWorker.fetch>[1]
    const call = (path: string, init: RequestInit = {}, token = 'synthetic-test-value') =>
      cloudWorker.fetch(
        new Request(`https://cloud.example${path}`, {
          ...init,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
        env,
      )
    Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
      configurable: true,
      value: timingSafeEqual,
    })
    try {
      // Only the bearer token admits; nothing reaches a replica or the Directory without it.
      for (const path of ['/sync/directory', `/sync/cloud?project=${KEY}`])
        for (const token of ['', 'wrong']) expect((await call(path, {}, token)).status).toBe(401)
      for (const path of ['/sync/move', '/sync/cancel'])
        expect(
          (await call(`${path}?project=${KEY}`, { method: 'POST', body: '{}' }, '')).status,
        ).toBe(401)
      expect(replicas).toEqual([])
      expect(listed).not.toHaveBeenCalled()

      expect(await (await call('/sync/directory')).json()).toEqual([{ key: KEY }])
      const own = await instance.fetch(new Request('https://cloud.example/api/cloud'))
      const expected = await own.json()
      expect(await (await call(`/sync/cloud?project=${KEY}`)).json()).toEqual(expected)
      // A relinked key reaches the replica it syncs to, as /sync/v2 does.
      expect(await (await call('/sync/cloud?project=github.com/hazat/renamed')).json()).toEqual(
        expected,
      )
      expect(replicas).toEqual([KEY, KEY])
      expect((await call('/sync/cloud')).status).toBe(400)
      expect((await call(`/sync/cloud?project=${KEY}`, { method: 'POST' })).status).toBe(405)

      expect(
        (await call(`/sync/cancel?project=${KEY}`, { method: 'POST', body: '{}' })).status,
      ).toBe(409)
      const moved = await call(`/sync/move?project=${KEY}`, {
        method: 'POST',
        body: JSON.stringify({ machine: 'laptop', force: true }),
      })
      expect(moved.status).toBe(202)
      const { id } = (await moved.json()) as { id: string }
      // The bearer route is @sync's: the target records the move as started by it.
      expect(laptop.sent().at(-1)).toEqual({ type: 'move-to', id, by: 'sync', force: true })
      const refused = await call(`/sync/move?project=${KEY}`, {
        method: 'POST',
        body: JSON.stringify({ machine: 'test' }),
      })
      expect({ status: refused.status, body: await refused.json() }).toEqual({
        status: 409,
        body: { error: 'runs there already' },
      })
      laptop.receive({ type: 'transition', value: { ...running(id), step: 'fetch' } })
      const cancelled = await call(`/sync/cancel?project=${KEY}`, { method: 'POST' })
      expect({ status: cancelled.status, body: await cancelled.json() }).toEqual({
        status: 202,
        body: { id },
      })
      expect(laptop.sent().at(-1)).toEqual({ type: 'cancel', id })
      // Any other /sync path still answers 404.
      expect((await call('/sync/other')).status).toBe(404)
    } finally {
      Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
    }
  })

  it('takes secret names after hello from writer and standbys, refreshing missing secrets without a reconnect', async () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello({ secrets: ['A'] }))
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop', root: '/laptop' }))
    const missing = async () =>
      (
        (await (await instance.fetch(new Request('https://cloud.example/api/cloud'))).json()) as {
          machines: { machine: string; missingSecrets: string[] }[]
        }
      ).machines.find((machine) => machine.machine === 'laptop')!.missingSecrets
    expect(await missing()).toEqual(['A'])
    // The standby adds the secret: the cloud stops listing it as missing, and every machine hears its role again.
    const writes = writer.sent().length
    laptop.receive({ type: 'secrets', secrets: ['A'], secretsComplete: true })
    expect(await missing()).toEqual([])
    expect(writer.sent()).toHaveLength(writes + 1)
    // The writer adds one: the lease names it, and the standby's role says it lacks it.
    writer.receive({ type: 'secrets', secrets: ['A', 'B'], secretsComplete: true })
    expect(instance.store.lease()?.secrets).toEqual(['A', 'B'])
    expect(laptop.sent().at(-1)).toMatchObject({
      type: 'role',
      role: 'standby',
      writer: { secrets: ['A', 'B'] },
    })
    expect(await missing()).toEqual(['B'])
    // The socket's checkout keeps them too, so a claim after a release takes the lease with current names.
    expect(laptop.socket.deserializeAttachment()).toMatchObject({
      checkout: { secrets: ['A'], secretsComplete: true },
    })
    // A standby's names never change the lease; malformed lists and unadmitted sockets change nothing.
    laptop.receive({ type: 'secrets', secrets: ['C'], secretsComplete: false })
    expect(instance.store.lease()).toMatchObject({ secrets: ['A', 'B'], secretsComplete: true })
    const before = [...instance.store.sql.exec('SELECT * FROM metadata ORDER BY 1')]
    for (const secrets of [['lower'], Array.from({ length: 65 }, (_, index) => `S${index}`)])
      writer.receive({ type: 'secrets', secrets, secretsComplete: true })
    connect().receive({ type: 'secrets', secrets: ['X'], secretsComplete: true })
    expect([...instance.store.sql.exec('SELECT * FROM metadata ORDER BY 1')]).toEqual(before)
    expect(writer.socket.close).not.toHaveBeenCalled()
    expect(laptop.socket.close).not.toHaveBeenCalled()
  })

  it("shows the writing checkout's tailnet address to standbys and the directory, refusing malformed ones", () => {
    const { instance, connect, updates } = shared()
    const writer = connect()
    writer.receive(hello({ tailnet: 'https://rog.tail3a3a66.ts.net:4747' }))
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop', root: '/laptop' }))
    expect(laptop.sent().at(-1)).toMatchObject({
      role: 'standby',
      writer: { machine: 'test', tailnet: 'https://rog.tail3a3a66.ts.net:4747' },
    })
    expect(updates.at(-1)?.writer.tailnet).toBe('https://rog.tail3a3a66.ts.net:4747')
    // A standby's own address is its machine's, never the writer's.
    laptop.receive({ type: 'tailnet', url: 'https://laptop.tail3a3a66.ts.net:4748' })
    expect(updates.at(-1)).toMatchObject({
      writer: { tailnet: 'https://rog.tail3a3a66.ts.net:4747' },
      machines: expect.arrayContaining([
        expect.objectContaining({
          machine: 'laptop',
          tailnet: 'https://laptop.tail3a3a66.ts.net:4748',
        }),
      ]),
    })
    // The writer loses its address (Tailscale stopped): standbys hear it at once.
    writer.receive({ type: 'tailnet', url: null })
    expect((laptop.sent().at(-1) as { writer: object }).writer).not.toHaveProperty('tailnet')
    expect(updates.at(-1)?.writer).not.toHaveProperty('tailnet')
    // Anything but a ts.net HTTPS origin changes nothing; a hello carrying one is refused.
    const before = [...instance.store.sql.exec('SELECT * FROM metadata ORDER BY 1')]
    for (const url of [
      'http://rog.tail3a3a66.ts.net:4747',
      'https://evil.example',
      'https://x.ts.net/p',
    ])
      writer.receive({ type: 'tailnet', url })
    expect([...instance.store.sql.exec('SELECT * FROM metadata ORDER BY 1')]).toEqual(before)
    const bad = connect()
    bad.receive(hello({ machine: 'bad', tailnet: 'https://evil.example' }))
    expect(bad.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, 'invalid hello')
  })

  it('names the worktrees a releasing writer leaves uncommitted in the handover and keeps them on the transition', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop' }))
    laptop.receive({
      type: 'transition',
      value: {
        ...running('move-1'),
        step: 'handover',
        steps: [{ name: 'handover', state: 'running' }],
      },
    })
    const dirty = ['/test', '/tmp/worktrees/feature']
    writer.receive({ type: 'release-waiting', by: 'laptop', tasks: 0, dirty })
    expect(laptop.sent().at(-2)).toEqual({ type: 'release-waiting', by: 'laptop', tasks: 0, dirty })
    expect(instance.store.transition()).toMatchObject({
      left: dirty,
      steps: [
        {
          name: 'handover',
          detail: '2 worktrees with uncommitted changes stay on test',
        },
      ],
    })
    // Later drain counts keep the list.
    writer.receive({ type: 'release-waiting', by: 'laptop', tasks: 1 })
    expect(instance.store.transition()?.steps[0].detail).toBe(
      'finishing 1 run · 2 worktrees with uncommitted changes stay on test',
    )
    // Unbounded lists are refused, by the writer and in a reported transition alike.
    for (const oversized of [
      Array.from({ length: 21 }, (_, index) => `/w/${index}`),
      [`/${'x'.repeat(500)}`],
    ]) {
      writer.receive({ type: 'release-waiting', by: 'laptop', tasks: 0, dirty: oversized })
      expect(instance.store.transition()?.left).toEqual(dirty)
      laptop.receive({
        type: 'transition',
        value: { ...running('move-1'), left: oversized },
      })
      expect(instance.store.transition()?.left).toEqual(dirty)
    }
  })

  it('forwards a forced request and keeps what a held release waits for on the transition', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    const laptop = connect()
    laptop.receive(hello({ machine: 'laptop' }))
    laptop.receive({
      type: 'transition',
      value: {
        ...running('move-1'),
        step: 'handover',
        steps: [{ name: 'handover', state: 'running' }],
      },
    })
    laptop.receive({ type: 'request-release', id: 'move-1', force: true })
    expect(writer.sent().at(-1)).toEqual({
      type: 'release-requested',
      by: 'laptop',
      id: 'move-1',
      force: true,
    })
    // The runs it waits for, by conversation.
    const runs = ['#12 Review the lease', '#14']
    writer.receive({ type: 'release-waiting', by: 'laptop', tasks: 3, runs })
    expect(laptop.sent().at(-2)).toEqual({ type: 'release-waiting', by: 'laptop', tasks: 3, runs })
    expect(instance.store.transition()).toMatchObject({
      waiting: runs,
      steps: [{ name: 'handover', detail: 'finishing 3 runs' }],
    })
    // Drained, it holds for the dirty worktrees: the runs go, the worktrees are what it waits for.
    writer.receive({ type: 'release-waiting', by: 'laptop', tasks: 0, dirty: ['/w/a'], held: true })
    expect(laptop.sent().at(-2)).toEqual({
      type: 'release-waiting',
      by: 'laptop',
      tasks: 0,
      dirty: ['/w/a'],
      held: true,
    })
    expect(instance.store.transition()?.waiting).toBeUndefined()
    expect(instance.store.transition()).toMatchObject({
      left: ['/w/a'],
      steps: [{ detail: 'waiting for 1 worktree with uncommitted changes' }],
    })
    // Committed: an empty list clears them before the release.
    writer.receive({ type: 'release-waiting', by: 'laptop', tasks: 0, dirty: [] })
    expect(instance.store.transition()?.left).toBeUndefined()
    expect(instance.store.transition()?.steps[0].detail).toBe('')
    // An unbounded run list is refused like an unbounded worktree list.
    writer.receive({ type: 'release-waiting', by: 'laptop', tasks: 1, runs: ['x'.repeat(501)] })
    expect(instance.store.transition()?.waiting).toBeUndefined()
  })

  it('makes a second checkout on the writer machine, at another root, a standby that replaces nothing', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    const other = connect()
    other.receive(hello({ root: '/elsewhere/test', port: 4900 }))
    expect(other.sent()).toEqual([
      expect.objectContaining({
        role: 'standby',
        writer: expect.objectContaining({ machine: 'test', root: '/test', online: true }),
      }),
    ])
    expect(writer.socket.close).not.toHaveBeenCalled()
    expect(instance.sockets()).toEqual([writer.machine])
    expect(instance.store.lease()).toMatchObject({ machine: 'test', root: '/test', port: 4800 })
    other.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    expect(instance.store.lease()?.machine).toBe('test')
  })

  it('gives a claimed lease to the claiming checkout, not to another checkout of its machine', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    writer.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    const claimant = connect()
    claimant.receive(hello({ epoch: 1 }))
    // A second checkout of the same machine says hello after the claimant, at another root.
    connect().receive(hello({ root: '/elsewhere/test', port: 4900, secrets: ['ELSEWHERE'] }))
    claimant.receive({ type: 'claim', epoch: 1 })
    expect(instance.store.lease()).toMatchObject({
      machine: 'test',
      epoch: 2,
      root: '/test',
      port: 4800,
      secrets: [],
    })
    const back = connect()
    back.receive(hello({ epoch: 2 }))
    expect(back.sent()[0]).toMatchObject({ type: 'role', role: 'writer', epoch: 2 })
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
    stale.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-2' } })
    expect(instance.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
    expect(instance.sockets()).toEqual([laptop.machine])
  })

  it('closes a hello with another root commit without changing data or sending anything', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    const before = [...instance.store.sql.exec('SELECT * FROM metadata ORDER BY 1')]
    const other = connect()
    other.receive(hello({ machine: 'laptop', rootCommit: 'b'.repeat(40) }))
    expect(other.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, 'root commit differs')
    expect(other.socket.send).not.toHaveBeenCalled()
    other.receive({ type: 'claim', epoch: 1 })
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

  it('restores socket roles from attachments after hibernation', () => {
    const sql = replica().sql
    const sockets: Socket[] = []
    const ctx = {
      id: { toString: () => '0123456789abcdef' },
      storage: { sql, transactionSync: <T>(run: () => T) => sql.transaction(run) },
      getWebSockets: () => sockets,
      waitUntil: vi.fn<() => void>(),
      setWebSocketAutoResponse: vi.fn<(pair: unknown) => void>(),
    }
    // Workers provides the pair; Node does not.
    vi.stubGlobal('WebSocketRequestResponsePair', function pair(request: string, response: string) {
      return { request, response }
    })
    const env = {
      DIRECTORY: {
        idFromName: () => 'directory',
        get: () => ({ fetch: async () => new Response() }),
      },
    } as unknown as ConstructorParameters<typeof SharedReplica>[1]
    let instance = new SharedReplica(
      ctx as unknown as ConstructorParameters<typeof SharedReplica>[0],
      env,
    )
    // Machines' liveness pings are answered without waking the object.
    expect(ctx.setWebSocketAutoResponse).toHaveBeenCalledWith({ request: 'ping', response: 'pong' })
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
    const previous = instance
    instance = new SharedReplica(
      ctx as unknown as ConstructorParameters<typeof SharedReplica>[0],
      env,
    )
    expect(instance.store).not.toBe(previous.store)
    expect(instance.sockets()).toEqual([writer.machine])
    // No new hello: the restored standby is still fenced off, and the restored writer can still release.
    standby.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-0' } })
    expect(instance.store.lease()?.machine).toBe('test')
    writer.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    expect(instance.store.lease()).toMatchObject({ machine: null, snapshot: { id: 'snap-1' } })

    // A standby's checkout survives hibernation: after a release its claim names its own root, not another's.
    instance = new SharedReplica(
      ctx as unknown as ConstructorParameters<typeof SharedReplica>[0],
      env,
    )
    standby.receive({ type: 'claim', epoch: 1 })
    expect(instance.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2, root: '/test' })
  })

  it('closes an admitted socket that claims without a checkout, so its claim settles on reconnect', () => {
    const { instance, connect } = shared()
    const writer = connect()
    writer.receive(hello())
    writer.receive({ type: 'release', epoch: 1, snapshot: { id: 'snap-1' } })
    const old = connect()
    old.socket.serializeAttachment({ key: KEY, machine: 'laptop', role: 'standby' })
    old.receive({ type: 'claim', epoch: 1 })
    expect(instance.store.lease()).toMatchObject({ machine: null, epoch: 1 })
    expect(old.sent()).toEqual([])
    expect(old.socket.close).toHaveBeenCalledWith(1012, 'Say hello again')
  })

  it('refuses a hello whose checkout could outgrow the socket attachment, and keeps admitted ones small', () => {
    const { connect } = shared()
    for (const oversized of [
      { root: `/${'r'.repeat(1024)}` },
      { machine: 'm'.repeat(129) },
      { secrets: Array.from({ length: 65 }, (_, index) => `SECRET_${index}`) },
      { secrets: [`A${'B'.repeat(64)}`] },
      { secrets: ['lower_case'] },
    ]) {
      const socket = connect()
      socket.receive(hello(oversized))
      expect(socket.socket.close).toHaveBeenCalledWith(PROJECT_MISMATCH, 'invalid hello')
    }
    const longest = `github.com/${'o'.repeat(100)}/${'r'.repeat(100)}`
    const largest = connect()
    largest.socket.serializeAttachment({ key: longest, alias: longest })
    largest.receive(
      hello({
        key: longest,
        root: `/${'r'.repeat(1023)}`,
        machine: 'm'.repeat(128),
        secrets: Array.from({ length: 64 }, (_, index) => `S${index}`.padEnd(64, 'X')),
      }),
    )
    expect(largest.socket.close).not.toHaveBeenCalled()
    expect(JSON.stringify(largest.socket.deserializeAttachment()).length).toBeLessThan(16384 / 2)
  })
})

describe('cloud directory', () => {
  it('lists one directory row per project with stable repository slugs, and forgets a free project nobody connects to', () => {
    const directory = new DirectoryStore(database())
    const listed = (key = 'github.com/hazat/ultimate') =>
      directory.list().find((project) => project.key === key)
    const value: Presence = {
      key: 'github.com/hazat/ultimate',
      name: 'ultimate',
      writer: { machine: 'haza-pc', online: true },
      machines: [
        { machine: 'haza-pc', role: 'writer', connected: true, lastSeen: 100 },
        { machine: 'rog', role: 'standby', connected: false, lastSeen: 50 },
      ],
    }
    directory.update(value)
    directory.update({ ...value, key: 'github.com/someone/ultimate' })
    directory.update({ ...value, key: 'github.com/hazat/poe2-rust', name: 'POE2 Rust' })
    expect(directory.list().map((row) => [row.slug, row.key])).toEqual([
      ['poe2-rust', 'github.com/hazat/poe2-rust'],
      ['ultimate', 'github.com/hazat/ultimate'],
      ['ultimate-2', 'github.com/someone/ultimate'],
    ])
    expect(listed()).toEqual({ ...value, slug: 'ultimate' })
    // An offline writer still holds the lease: the project stays listed.
    const offline = {
      ...value,
      writer: { machine: 'haza-pc', online: false },
      machines: value.machines.map((machine) => ({ ...machine, connected: false })),
    }
    directory.update(offline)
    expect(listed()).toMatchObject({ writer: { online: false } })
    // A free lease with a machine connected stays too; with nobody connected it is gone.
    directory.update({ ...value, writer: { machine: null, online: false } })
    expect(listed()).toMatchObject({ writer: { machine: null } })
    directory.update({ ...offline, writer: { machine: null, online: false } })
    expect(listed()).toBeUndefined()
    expect(directory.list()).toHaveLength(2)
    // The slug stays reserved for the returning project.
    directory.update(value)
    expect(listed()?.slug).toBe('ultimate')
  })
})
