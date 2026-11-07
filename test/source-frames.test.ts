import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { fetchAssets, sourceFrames } from '../lib/source-frames.ts'

// `function Crash(){throw new Error("x")}` from /repo/extensions/a/web.tsx line 3, column 9, in one minified line.
const script = 'function Crash(){throw new Error("x")}\n//# sourceMappingURL=web-1.js.map\n'
const map = JSON.stringify({
  version: 3,
  sources: ['/repo/extensions/a/web.tsx'],
  names: [],
  mappings: 'AAEQ',
})
const files: Record<string, string> = {
  'http://host/assets/web-1.js': script,
  'http://host/assets/web-1.js.map': map,
}

it('maps bundled frames to their source files and keeps the rest', async () => {
  const fetched: string[] = []
  const stack = [
    'Error: x',
    '    at Crash (http://host/assets/web-1.js:1:17)',
    '    at Crash (http://host/assets/web-1.js:1:17)',
    '    at Other (http://host/assets/gone.js:2:5)',
    '    at div (<anonymous>)',
  ].join('\n')
  const source = await sourceFrames(stack, async (url) => {
    fetched.push(url)
    return files[url]
  })
  expect(source).toBe(
    [
      'Error: x',
      '    at Crash (/repo/extensions/a/web.tsx:3:9)',
      '    at Crash (/repo/extensions/a/web.tsx:3:9)',
      '    at Other (http://host/assets/gone.js:2:5)',
      '    at div (<anonymous>)',
    ].join('\n'),
  )
  // Each script and its map are read once.
  expect(fetched).toEqual([
    'http://host/assets/web-1.js',
    'http://host/assets/gone.js',
    'http://host/assets/web-1.js.map',
  ])
})

afterEach(() => vi.unstubAllGlobals())

it("fetches only its own origin's bundle assets", async () => {
  const requested: string[] = []
  vi.stubGlobal('fetch', async (url: URL | string) => {
    requested.push(String(url))
    return new Response('x')
  })
  const read = fetchAssets('http://host')
  expect(await read('http://127.0.0.1:1/assets/x.js')).toBe('x')
  expect(requested).toEqual(['http://host/assets/x.js'])
  requested.length = 0
  expect(await read('http://host/api/secret.js')).toBeUndefined()
  expect(await read('http://[bad]/assets/x.js')).toBeUndefined()
  expect(requested).toEqual([])
  const text = 'Error\n    at x (http://[bad]/assets/x.js:1:1)'
  expect(await sourceFrames(text, read)).toBe(text)
})

// An asset that redirected made this server follow it to any address, such as localhost or the tailnet (#95583).
it('does not follow an asset redirect', async () => {
  const hits: string[] = []
  const server = createServer((request, response) => {
    hits.push(request.url ?? '')
    if (request.url === '/assets/x.js') response.writeHead(302, { Location: '/private' })
    response.end('private')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect(await fetchAssets(origin)(`${origin}/assets/x.js`)).toBeUndefined()
    expect(hits).toEqual(['/assets/x.js'])
  } finally {
    await new Promise((done) => server.close(done))
  }
})

// A page's error text could name many scripts, on many host names, and each was downloaded whole (#95583).
it('fetches one asset once whatever host names frames give it, and maps a bounded number of scripts', async () => {
  const requested: string[] = []
  vi.stubGlobal('fetch', async (url: URL | string) => {
    requested.push(String(url))
    return new Response('code')
  })
  const read = fetchAssets('http://host')
  const same = Array.from({ length: 20 }, (_, i) => `at f (http://h${i}.example/assets/a.js:1:1)`)
  await sourceFrames(same.join('\n'), read)
  expect(requested).toEqual(['http://host/assets/a.js'])
  requested.length = 0
  const many = Array.from({ length: 40 }, (_, i) => `at f (http://host/assets/s${i}.js:1:1)`)
  await sourceFrames(many.join('\n'), fetchAssets('http://host'))
  expect(requested).toHaveLength(8)
})
