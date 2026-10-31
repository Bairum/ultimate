import { expect, it, vi } from 'vitest'
import { fixture, servers } from './server-fixture.ts'
import { cookieHeaders, post, temp, fauxServer } from './helpers.ts'
import { classify, userCookie } from '../server/request-security.ts'
import type { PairingOpener } from '../server/request-security.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Messages } from '../extensions/messages/api.ts'
import { context } from '../server/harness.ts'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'

const source = `import { defineExtension } from '@earendil-works/pi-durable'
export default defineExtension({ name: 'boundary' })
export const userActions = ['change', 'hostChange']
export const hostActions = ['hostChange']
export const peerActions = ['remote']
export const actions = {
  change: () => 'changed', hostChange: () => 'host changed', remote: () => 'remote',
  agent: async (_, {host,signal}) => {
    try { await host.invoke('boundary','remote',{},signal); return 'unexpected' }
    catch (error) { return error.message }
  }
}`

it('classifies cookies independently of forged browser and proxy headers', async () => {
  const cookie = await userCookie(await temp())
  for (const headers of [
    {},
    { origin: 'http://127.0.0.1:4747' },
    { 'sec-fetch-site': 'same-origin' },
    {
      host: 'ultimate.example.ts.net',
      'x-forwarded-for': '100.64.0.1',
      'tailscale-user-login': 'owner',
    },
    { cookie: cookie.slice(0, -1) },
    { cookie: cookie + 'tampered' },
  ])
    expect(classify(headers, cookie)).toEqual({ user: false, host: false })
  expect(classify({ cookie: 'other=x; ' + cookie }, cookie)).toEqual({ user: true, host: true })
})

it('requires pairing for HTTP user actions and submits, but admits peer actions only over HTTP', async () => {
  const { server } = await fixture(false, { boundary: source })
  const action = '/api/extensions/boundary/actions/'
  const raw = (path: string, headers = {}) =>
    fetch(server.url + path, {
      method: 'POST',
      headers: { Origin: server.url, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(path.endsWith('/submit') ? { text: 'hello' } : {}),
    })
  expect((await raw(action + 'change')).status).toBe(403)
  expect(await post(server, action + 'change')).toEqual({
    status: 200,
    data: { result: 'changed' },
  })
  expect((await raw('/api/conversations/1/submit')).status).toBe(403)
  expect((await raw('/api/conversations/1/submit', cookieHeaders(server))).status).toBe(202)
  expect(await (await raw(action + 'remote')).json()).toEqual({ result: 'remote' })
  expect(await (await raw(action + 'agent')).json()).toEqual({
    result: 'boundary/remote is a user-only action',
  })
})

it('opens a single-use, origin-bound pairing link without pairing page loads', async () => {
  const opener = vi.fn<PairingOpener>()
  const { server } = await fixture(false, { boundary: source }, false, { pairingOpener: opener })
  expect((await fetch(server.url + '/')).headers.get('set-cookie')).toBeNull()
  expect(await (await fetch(server.url + '/api/whoami')).json()).toEqual({
    user: false,
    host: false,
  })
  const open = () =>
    fetch(server.url + '/api/pair', {
      method: 'POST',
      headers: { 'User-Agent': 'Chrome/141.0' },
    })
  expect((await open()).status).toBe(202)
  expect((await open()).status).toBe(429)
  expect(opener).toHaveBeenCalledTimes(1)
  const url = opener.mock.calls[0][0]
  expect(url).toMatch(new RegExp(`^${server.url}/api/pair\\?code=[A-Za-z0-9_-]{43}$`))
  expect(opener.mock.calls[0][1]).toEqual({ device: 'desktop chrome' })
  const paired = await fetch(url, { redirect: 'manual' })
  expect(paired.status).toBe(302)
  expect(paired.headers.get('location')).toBe('/')
  expect(paired.headers.get('set-cookie')).toBe(
    `${cookieHeaders(server).Cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`,
  )
  expect((await fetch(url, { redirect: 'manual' })).status).toBe(403)
  expect(
    await (await fetch(server.url + '/api/whoami', { headers: cookieHeaders(server) })).json(),
  ).toEqual({ user: true, host: true })

  const linked = await post(server, '/api/pair/link')
  const link = (linked.data as { url: string }).url
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001)
  expect((await fetch(link, { redirect: 'manual' })).status).toBe(403)
  // Keep expiry deterministic without faking the HTTP server's event loop.
  vi.restoreAllMocks()
  expect(
    (
      await fetch(server.url + '/api/pair', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '127.0.0.1' },
      })
    ).status,
  ).toBe(403)
})

it('lets previews use scratch user actions but not host actions without the real cookie', async () => {
  const { server } = await fixture(false, { boundary: source }, false, { instance: true })
  expect(await (await fetch(server.url + '/api/whoami')).json()).toEqual({
    user: true,
    host: false,
  })
  const raw = (name: string, headers = {}) =>
    fetch(server.url + '/api/extensions/boundary/actions/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    })
  expect((await raw('change')).status).toBe(200)
  expect((await raw('hostChange')).status).toBe(403)
  expect((await raw('hostChange', cookieHeaders(server))).status).toBe(200)
})

it('accepts the real messages/remote HTTP action without browser headers or a cookie', async () => {
  const userHome = await temp()
  const projectRoot = join(userHome, 'project')
  await mkdir(projectRoot)
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    home: join(userHome, 'state'),
    userHome,
  })
  servers.push(server)
  const response = await fetch(server.url + '/api/extensions/messages/actions/remote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      args: {
        key: 'peer-http',
        text: 'A peer update',
        reply: false,
        from: { project: 'peer', machine: 'test' },
      },
    }),
  })
  expect(response.status).toBe(200)
  const { result } = (await response.json()) as { result: number }
  const log = await server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context)
  expect(log?.messages.find((message) => message.id === result)).toMatchObject({
    from: 'remote',
    text: 'A peer update',
    remote: { key: 'peer-http', project: 'peer', machine: 'test' },
  })
})

it('does not serve private config or the pairing key through Vite while serving user extension assets', async () => {
  const { server, options } = await fixture(false, { boundary: source })
  const config = join(options.userHome, '.ultimate')
  await writeFile(join(config, 'secrets.json'), '{"synthetic":true}', { mode: 0o600 })
  await mkdir(join(config, 'extensions'), { recursive: true })
  await writeFile(join(config, 'extensions/asset.txt'), 'extension asset')
  const read = (file: string) => fetch(`${server.url}/@fs/${join(config, file)}`)
  expect((await read('secrets.json')).status).toBe(403)
  expect((await read('user-key?url&inline')).status).toBe(403)
  const asset = await read('extensions/asset.txt')
  expect(asset.status).toBe(200)
  expect(await asset.text()).toBe('extension asset')
})
