import { timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import worker, { ProjectDirectory } from '../cloud/worker.ts'
import { DirectoryStore } from '../cloud/directory.ts'
import type { MachineHealth } from '../cloud/protocol.ts'

let db: DatabaseSync
let store: DirectoryStore
let env: Parameters<typeof worker.fetch>[1]

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  store = new DirectoryStore({
    exec: <T extends Record<string, unknown>>(
      query: string,
      ...bindings: (string | number | null)[]
    ) => {
      const statement = db.prepare(query)
      if (statement.columns().length) return statement.all(...bindings) as T[]
      statement.run(...bindings)
      return []
    },
    transaction: (run) => run(),
  })
  const directory = Object.assign(Object.create(ProjectDirectory.prototype) as ProjectDirectory, {
    store,
  })
  env = {
    SYNC_TOKEN: 'dev',
    ACCESS_DEV_BYPASS: '1',
    DIRECTORY: {
      idFromName: () => 'directory',
      get: () => ({
        fetch: (input: string, init?: RequestInit) => directory.fetch(new Request(input, init)),
      }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1]
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
})

afterEach(() => {
  Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
  db.close()
})

const desk: MachineHealth = {
  machine: 'desk',
  at: 1000,
  providers: [
    { provider: 'openai-codex', state: 'ok', lastOk: 900, lastUsed: 900 },
    { provider: 'anthropic', state: 'failing', lastOk: 100, lastFail: 800, error: 'invalid_grant' },
    { provider: 'claude-code', state: 'unknown' },
  ],
}

it('upserts one report per machine and lists them by name', () => {
  expect(store.health({ machine: 'laptop', at: 1, providers: [] })).toBe(true)
  expect(store.health({ ...desk, at: 1 })).toBe(true)
  expect(store.health(desk)).toBe(true)
  expect(store.healthList()).toEqual([desk, { machine: 'laptop', at: 1, providers: [] }])
})

it('refuses malformed reports, cuts long errors and drops unknown fields', () => {
  const provider = { provider: 'p', state: 'ok' }
  for (const bad of [
    null,
    'desk',
    { at: 1, providers: [] },
    { machine: '', at: 1, providers: [] },
    { machine: 'm'.repeat(65), at: 1, providers: [] },
    { machine: 'desk', at: '1', providers: [] },
    { machine: 'desk', at: 1, providers: {} },
    { machine: 'desk', at: 1, providers: Array.from({ length: 17 }, () => provider) },
    { machine: 'desk', at: 1, providers: [{ ...provider, provider: 'p'.repeat(65) }] },
    { machine: 'desk', at: 1, providers: [{ ...provider, state: 'broken' }] },
    { machine: 'desk', at: 1, providers: [{ ...provider, lastOk: 'yesterday' }] },
    { machine: 'desk', at: 1, providers: [{ ...provider, error: 42 }] },
    { machine: 'desk', at: 1, providers: [null] },
  ])
    expect(store.health(bad)).toBe(false)
  expect(store.healthList()).toEqual([])
  expect(
    store.health({
      machine: 'desk',
      at: 1,
      token: 'secret',
      providers: [
        { provider: 'p', state: 'failing', lastFail: 1, error: 'x'.repeat(500), auth: 'k' },
      ],
    }),
  ).toBe(true)
  expect(store.healthList()).toEqual([
    {
      machine: 'desk',
      at: 1,
      providers: [{ provider: 'p', state: 'failing', lastFail: 1, error: 'x'.repeat(200) }],
    },
  ])
})

it('stores health posted with the sync token and lists it on /sync/health and /api/health', async () => {
  const post = (body: string, token?: string) =>
    worker.fetch(
      new Request('https://cloud.example/sync/health', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body,
      }),
      env,
    )
  expect((await post(JSON.stringify(desk))).status).toBe(401)
  expect((await post(JSON.stringify(desk), 'wrong')).status).toBe(401)
  expect(store.healthList()).toEqual([])
  expect((await post('not json', 'dev')).status).toBe(400)
  expect((await post(JSON.stringify({ ...desk, machine: '' }), 'dev')).status).toBe(400)
  expect((await post(JSON.stringify(desk), 'dev')).status).toBe(204)
  expect(store.healthList()).toEqual([desk])

  const get = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://cloud.example${path}`, { headers }), env)
  expect((await get('/sync/health')).status).toBe(401)
  expect(await (await get('/sync/health', { Authorization: 'Bearer dev' })).json()).toEqual([desk])
  expect(await (await get('/api/health')).json()).toEqual([desk])
  const { ACCESS_DEV_BYPASS: _bypass, ...guarded } = env
  expect(
    (await worker.fetch(new Request('https://cloud.example/api/health'), guarded)).status,
  ).toBe(401)
})

it('stores health with a PUT the presence route never sees, and refuses a malformed presence with 400', async () => {
  const directory = (init: { method: string; body: string }) =>
    env.DIRECTORY.get(env.DIRECTORY.idFromName('directory')).fetch('https://directory/health', init)
  // The production failure: a health report reaching the presence path threw on `name.toLowerCase()`.
  const asPresence = await env.DIRECTORY.get(env.DIRECTORY.idFromName('directory')).fetch(
    'https://directory/update',
    { method: 'POST', body: JSON.stringify(desk) },
  )
  expect(asPresence.status).toBe(400)
  expect(store.list()).toEqual([])
  expect((await directory({ method: 'PUT', body: JSON.stringify(desk) })).status).toBe(204)
  expect(store.healthList()).toEqual([desk])
})

it('refuses health bodies over 16 KiB, declared or streamed', async () => {
  const big = JSON.stringify({ ...desk, padding: 'x'.repeat(16 * 1024) })
  const declared = await worker.fetch(
    new Request('https://cloud.example/sync/health', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev' },
      body: big,
    }),
    env,
  )
  expect(declared.status).toBe(413)
  const streamed = await worker.fetch(
    new Request('https://cloud.example/sync/health', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev' },
      body: new Blob([big]).stream(),
      duplex: 'half',
    } as RequestInit),
    env,
  )
  expect(streamed.status).toBe(413)
  expect(store.healthList()).toEqual([])
})
