// A deploy switches the Worker at once, while Durable Objects keep running the previous code until they restart.
// Each new Worker→DO call is tested here against a frozen copy of the handler it may still reach.
import { timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import worker from '../cloud/worker.ts'
import { DirectoryStore } from '../cloud/directory.ts'
import type { Presence } from '../cloud/directory.ts'
import type { MachineHealth } from '../cloud/protocol.ts'

type Env = Parameters<typeof worker.fetch>[1]
type Handler = (request: Request) => Promise<Response>

/** `ProjectDirectory.fetch` as deployed at b16c3a8^, before `/sync/health` existed: any POST is a presence. */
const directoryBeforeHealth =
  (store: DirectoryStore): Handler =>
  async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/alias') {
      if (request.method === 'POST') {
        const { key, from }: { key: string; from: string } = await request.json()
        return store.alias(key, from)
          ? new Response(null, { status: 204 })
          : Response.json({ error: 'A project cannot alias itself' }, { status: 400 })
      }
      const target = store.target(url.searchParams.get('key') ?? '')
      return target
        ? Response.json({ target })
        : Response.json({ error: 'No alias' }, { status: 404 })
    }
    if (request.method === 'POST') {
      const presence: Presence = await request.json()
      store.update(presence)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/list') return Response.json(store.list())
    const value = store.resolve(url.searchParams.get('slug') ?? '')
    return value
      ? Response.json(value)
      : Response.json({ error: 'Unknown project' }, { status: 404 })
  }

let db: DatabaseSync
let store: DirectoryStore

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
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
})

afterEach(() => {
  Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
  db.close()
})

/**
 * The new Worker with `DIRECTORY` still on `old`. An exception the old object throws reaches the Worker's stub call,
 * and the runtime answers it with a 500; any other exception is a broken test and fails it.
 */
async function againstOld(old: Handler, request: Request) {
  const thrown = new Set<unknown>()
  const fetch = (input: string, init?: RequestInit) =>
    old(new Request(input, init)).catch((error: unknown) => {
      thrown.add(error)
      throw error
    })
  const env = {
    SYNC_TOKEN: 'dev',
    DIRECTORY: { idFromName: () => 'directory', get: () => ({ fetch }) },
  }
  try {
    return await worker.fetch(request, env as unknown as Env)
  } catch (error) {
    if (!thrown.has(error)) throw error
    return Response.json({ thrown: String(error) }, { status: 500 })
  }
}

it('health reported to a directory still on code from before the route gets a 404 the reporter retries', async () => {
  const health: MachineHealth = { machine: 'desk', at: 1, providers: [] }
  const response = await againstOld(
    directoryBeforeHealth(store),
    new Request('https://cloud.example/sync/health', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev' },
      body: JSON.stringify(health),
    }),
  )
  // Not ok, so `extensions/health` keeps the report pending and sends it again on its next tick.
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 404,
    body: { error: 'Unknown project' },
  })
  expect(store.list()).toEqual([])
})
