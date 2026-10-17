import { createHash, timingSafeEqual } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import worker from '../cloud/worker.ts'
import { uploadBuild, MAX_BUILD, MAX_FILE } from '../cloud/builds.ts'
import type { R2Bucket } from '@cloudflare/workers-types'

type Env = Parameters<typeof worker.fetch>[1]
it.each(['/sync/builds/0123456789ab', '/p/desk/one/', '/b/0123456789ab/assets/test.js'])(
  'authenticates %s before any binding',
  async (path) => {
    const touch = vi.fn<() => never>(() => {
      throw new Error('binding touched')
    })
    const env = new Proxy(
      {},
      {
        get: (_, key) =>
          ['ASSETS', 'BUILDS', 'DIRECTORY', 'REPLICA'].includes(String(key)) ? touch() : undefined,
      },
    ) as Env
    expect((await worker.fetch(new Request(`https://cloud.example${path}`), env)).status).toBe(401)
    expect(touch).not.toHaveBeenCalled()
  },
)
it('serves private project HTML with its UI version, falling back without a build', async () => {
  let uiBuild: string | undefined = '0123456789ab'
  const env = {
    ACCESS_DEV_BYPASS: '1',
    VERSION: { id: 'worker' },
    DIRECTORY: {
      idFromName: () => 'directory',
      get: () => ({
        fetch: async () => Response.json({ machine: 'desk', project: '/one', uiBuild }),
      }),
    },
    BUILDS: { get: async () => ({ body: 'private HTML' }) },
    ASSETS: { fetch: async () => fetch('data:text/plain,generic') },
    REPLICA: {
      idFromName: () => 'replica',
      get: () => ({ fetch: async () => fetch('data:text/plain,api') }),
    },
  } as unknown as Env
  const response = await worker.fetch(new Request('https://cloud.example/p/desk/one/'), env)
  expect(await response.text()).toBe('private HTML')
  expect(response.headers.get('x-ultimate-cloud-version')).toBe('worker:0123456789ab')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  const api = await worker.fetch(new Request('https://cloud.example/p/desk/one/api/models'), env)
  expect(api.headers.get('x-ultimate-cloud-version')).toBe('worker:0123456789ab')
  expect(await api.text()).toBe('api')
  uiBuild = undefined
  expect(
    await (await worker.fetch(new Request('https://cloud.example/p/desk/one/'), env)).text(),
  ).toBe('generic')
})
// An R2 list stub that pages one key at a time, so a missing cursor loop drops keys.
function listing(held: Set<string> | Map<string, string>) {
  return async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
    const keys = [...held.keys()].filter((key) => key.startsWith(prefix)).toSorted()
    const start = cursor ? Number(cursor) : 0
    return {
      objects: keys.slice(start, start + 1).map((key) => ({ key })),
      truncated: start + 1 < keys.length,
      cursor: String(start + 1),
    }
  }
}

it('checks missing names, deduplicates assets and rejects paths and excessive manifests', async () => {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
  const held = new Set<string>()
  const env = {
    SYNC_TOKEN: 'dev',
    // No head(): the missing-name check must list prefixes, not probe every file.
    BUILDS: {
      list: listing(held),
      put: async (key: string) => {
        held.add(key)
      },
    },
  } as unknown as Env
  const call = (id: string, method: string, body: unknown) =>
    worker.fetch(
      new Request(`https://cloud.example/sync/builds/${id}`, {
        method,
        headers: { Authorization: 'Bearer dev' },
        body: JSON.stringify(body),
      }),
      env,
    )
  const files = [
    { name: 'index.html', size: 4 },
    { name: 'assets/main-abcdefgh.js', size: 4 },
  ]
  try {
    expect(await (await call('0123456789ab', 'POST', files)).json()).toEqual({
      missing: files.map((f) => f.name),
    })
    held.add('ui/assets/main-abcdefgh.js')
    held.add('ui/assets/other-abcdefgh.js')
    expect(await (await call('1123456789ab', 'POST', files)).json()).toEqual({
      missing: ['index.html'],
    })
    expect((await call('0123456789ab', 'POST', [{ name: '../secret', size: 1 }])).status).toBe(400)
    expect(
      (await call('0123456789ab', 'POST', [{ name: 'index.html', size: 30_000_000 }])).status,
    ).toBe(400)
  } finally {
    Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
  }
})

it('enforces the manifest byte budget, actual PUT size and index hash; retains old builds and protects assets', async () => {
  const held = new Map<string, string>()
  const bucket = {
    list: listing(held),
    get: async (key: string) =>
      held.has(key) ? { body: held.get(key), json: async () => JSON.parse(held.get(key)!) } : null,
    put: async (key: string, value: string | Uint8Array) => {
      held.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value))
    },
  } as unknown as R2Bucket
  const html = '<html>one</html>'
  const id = createHash('sha256').update(html).digest('hex').slice(0, 12)
  const call = (method: string, body: string, name?: string) =>
    uploadBuild(new Request('https://cloud.example', { method, body }), bucket, id, name)
  const overBudget = Array.from({ length: Math.ceil(MAX_BUILD / MAX_FILE) + 1 }, (_, i) => ({
    name: i ? `assets/chunk-${i}.js` : 'index.html',
    size: MAX_FILE,
  }))
  expect((await call('POST', JSON.stringify(overBudget))).status).toBe(400)
  await call(
    'POST',
    JSON.stringify([
      { name: 'index.html', size: html.length },
      { name: 'assets/main-abcdefgh.js', size: 4 },
    ]),
  )
  expect((await call('PUT', '12345', 'assets/main-abcdefgh.js')).status).toBe(400)
  expect((await call('PUT', '1234', 'assets/unknown.js')).status).toBe(400)
  expect((await call('PUT', html.replace('one', 'two'), 'index.html')).status).toBe(400)
  expect((await call('PUT', html, 'index.html')).status).toBe(204)
  expect((await call('PUT', '1234', 'assets/main-abcdefgh.js')).status).toBe(204)
  const env = { ACCESS_DEV_BYPASS: '1', BUILDS: bucket } as Env
  const old = await worker.fetch(new Request(`https://cloud.example/b/${id}/`), env)
  expect(await old.text()).toBe(html)
  const asset = await worker.fetch(
    new Request(`https://cloud.example/b/${id}/assets/main-abcdefgh.js`),
    env,
  )
  expect(await asset.text()).toBe('1234')
  expect(asset.headers.get('cache-control')).toContain('immutable')
  expect(asset.headers.get('content-type')).toContain('javascript')
  expect(
    (
      await worker.fetch(new Request(`https://cloud.example/b/${id}/assets/main-abcdefgh.js`), {
        BUILDS: bucket,
      } as Env)
    ).status,
  ).toBe(401)
})
