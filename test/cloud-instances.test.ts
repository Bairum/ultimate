import { timingSafeEqual } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import worker from '../cloud/worker.ts'
import { createApi, projectBase } from '../web/src/sdk/api.ts'
import { createStore } from '../web/src/sdk/store.ts'

it('routes sync by both machine and project', async () => {
  const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('sync'))
  const idFromName = vi.fn<(name: string) => string>((name) => name)
  const env = {
    SYNC_TOKEN: 'dev',
    REPLICA: { idFromName, get: () => ({ fetch }) },
  } as unknown as Parameters<typeof worker.fetch>[1]
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
  try {
    for (const project of ['/one', '/two']) {
      await worker.fetch(
        new Request(
          `https://cloud.example/sync?machine=desk&project=${encodeURIComponent(project)}`,
          { headers: { Authorization: 'Bearer dev' } },
        ),
        env,
      )
      expect(idFromName).toHaveBeenLastCalledWith(JSON.stringify(['desk', project]))
    }
  } finally {
    Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
  }
})

it.each(['/api/directory', '/api', '/p/desk/one/api/events', '/p/desk/one/api'])(
  'authenticates %s before touching any object',
  async (path) => {
    const get = vi.fn<() => never>(() => {
      throw new Error('must not touch object')
    })
    const env = {
      REPLICA: { get, idFromName: get },
      DIRECTORY: { get, idFromName: get },
    } as unknown as Parameters<typeof worker.fetch>[1]
    expect((await worker.fetch(new Request(`https://cloud.example${path}`), env)).status).toBe(401)
    expect(get).not.toHaveBeenCalled()
  },
)

it('strips the project prefix before forwarding the API request', async () => {
  const forward = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response('project'),
  )
  const idFromName = vi.fn<(name: string) => string>((name) => name)
  const env = {
    ACCESS_DEV_BYPASS: '1',
    DIRECTORY: {
      idFromName: () => 'directory',
      get: () => ({ fetch: async () => Response.json({ machine: 'Desk', project: '/one' }) }),
    },
    REPLICA: { idFromName, get: () => ({ fetch: forward }) },
  } as unknown as Parameters<typeof worker.fetch>[1]
  await worker.fetch(new Request('https://cloud.example/p/desk/one/api/events?conversation=2'), env)
  expect(new URL(forward.mock.calls[0][0].url).pathname).toBe('/api/events')
  expect(new URL(forward.mock.calls[0][0].url).search).toBe('?conversation=2')
  expect(idFromName).toHaveBeenCalledWith(JSON.stringify(['Desk', '/one']))
})

it.each(['/', '/p/desk/one/'])(
  'uses the SDK base for writes, history, models and event streams at %s',
  async (path) => {
    vi.stubGlobal('location', { pathname: path })
    try {
      const request = vi.fn<typeof fetch>(async () => Response.json({}))
      const open = vi.fn<(url: string) => EventSource>(
        () => ({ close() {}, addEventListener() {} }) as unknown as EventSource,
      )
      const store = createStore({ fetch: request, eventSource: open })
      const api = createApi(store, { fetch: request })
      await api.submit('test')
      await api.history(1, 10)
      await store.refreshModels()
      store.start()
      const base = projectBase(path)
      expect(request.mock.calls.map((call) => call[0])).toEqual([
        `${base}/api/conversations/1/submit`,
        `${base}/api/conversations/1/history?before=10`,
        `${base}/api/models`,
      ])
      expect(open.mock.calls[0][0]).toBe(`${base}/api/events`)
      store.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  },
)

it('serves the front page shell from assets without touching the directory', async () => {
  const assets = vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response('<div id="app"></div>'),
  )
  const get = vi.fn<() => never>(() => {
    throw new Error('must not touch object')
  })
  const env = {
    ASSETS: { fetch: assets },
    REPLICA: { get, idFromName: get },
    DIRECTORY: { get, idFromName: get },
  } as unknown as Parameters<typeof worker.fetch>[1]
  const response = await worker.fetch(new Request('https://cloud.example/'), env)
  expect(await response.text()).toBe('<div id="app"></div>')
  expect(new URL(assets.mock.calls[0][0].url).pathname).toBe('/front/')
  expect(get).not.toHaveBeenCalled()
})

it('derives the SDK base without changing local URLs', () => {
  expect(projectBase('/')).toBe('')
  expect(projectBase('/p/desk/one/')).toBe('/p/desk/one')
  expect(projectBase('/p/desk/one/api/events')).toBe('/p/desk/one')
})
