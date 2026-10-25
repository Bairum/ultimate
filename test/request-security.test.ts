import { expect, it } from 'vitest'
import { admit, deviceOf, loopbackAuthority, loopbackOrigin } from '../server/request-security.ts'

it.each(['127.0.0.1', 'localhost', '[::1]', 'ultimate.localhost', 'preview.ultimate.localhost'])(
  'admits direct loopback host and origin %s on the listening port',
  async (host) => {
    expect(loopbackAuthority(`${host}:4799`, '4799')).toBe(true)
    expect(loopbackOrigin(`http://${host}:4799`, '4799')).toBe(true)
    expect(
      await admit(
        { headers: { host: `${host}:4799`, origin: `http://${host}:4799` } },
        '4799',
        new Set(),
      ),
    ).toBe(true)
  },
)

it.each([
  'evil.com:4799',
  'localhost.evil.com:4799',
  'ultimatelocalhost:4799',
  'ultimate.localhost:4800',
])('rejects foreign or wrong-port authority %s and its origin', async (host) => {
  expect(loopbackAuthority(host, '4799')).toBe(false)
  expect(loopbackOrigin(`http://${host}`, '4799')).toBe(false)
  expect(await admit({ headers: { host } }, '4799', new Set())).toBe(false)
  expect(
    await admit(
      { headers: { host: 'ultimate.localhost:4799', origin: `http://${host}` } },
      '4799',
      new Set(),
    ),
  ).toBe(false)
})

it('does not admit forwarded localhost subdomains', async () => {
  expect(
    await admit(
      { headers: { host: 'ultimate.localhost:4799', 'x-forwarded-for': '127.0.0.1' } },
      '4799',
      new Set(),
    ),
  ).toBe(false)
})

it('labels a request by its browser, with the Tailscale login only behind Serve', () => {
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'
  expect(deviceOf({ 'user-agent': iphone })).toEqual({ device: 'phone safari' })
  expect(
    deviceOf({
      'user-agent': linux,
      'tailscale-user-login': 'me@example.com',
      'x-forwarded-for': '100.64.0.2',
    }),
  ).toEqual({ device: 'desktop chrome', login: 'me@example.com' })
  // A login header that no proxy set is a local client's claim, not Tailscale's.
  expect(deviceOf({ 'user-agent': linux, 'tailscale-user-login': 'me@example.com' })).toEqual({
    device: 'desktop chrome',
  })
  expect(deviceOf({})).toEqual({ device: 'desktop other' })
})

it('admits only exact pairing-link cross-site document navigations with access verification', async () => {
  const headers = {
    host: 'ultimate.example.ts.net',
    'x-forwarded-for': '100.64.0.1',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  }
  const rules = new Set([
    { origin: 'https://ultimate.example.ts.net', verify: () => ({ login: 'owner' }) },
  ])
  expect(await admit({ headers, method: 'GET', url: '/api/pair?code=x' }, '4747', rules)).toBe(true)
  for (const url of [
    '/api/pair',
    '/api/pairing?code=x',
    '/api/pair/extra?code=x',
    '/api/pair/link?code=x',
  ])
    expect(await admit({ headers, method: 'GET', url }, '4747', rules)).toBe(false)
  expect(await admit({ headers, method: 'POST', url: '/api/pair?code=x' }, '4747', rules)).toBe(
    false,
  )
  expect(
    await admit(
      { headers: { ...headers, upgrade: 'websocket' }, method: 'GET', url: '/api/pair?code=x' },
      '4747',
      rules,
    ),
  ).toBe(false)
})
