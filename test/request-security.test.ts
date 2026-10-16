import { expect, it } from 'vitest'
import { admit, loopbackAuthority, loopbackOrigin } from '../server/request-security.ts'

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
