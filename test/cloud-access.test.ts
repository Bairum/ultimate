import { timingSafeEqual } from 'node:crypto'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { admitsAccess } from '../cloud/access.ts'
import worker, { ProjectReplica } from '../cloud/worker.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const config = { ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', ACCESS_AUD: 'application' }
let privateKey: CryptoKey
let jwk: JsonWebKey
const certs = vi.fn<typeof fetch>()
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  privateKey = pair.privateKey
  jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
})
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
async function signed(claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000)
  const message = `${encode({ alg: 'RS256', kid: 'test', ...header })}.${encode({
    iss: `https://${config.ACCESS_TEAM_DOMAIN}`,
    aud: [config.ACCESS_AUD],
    exp: now + 60,
    nbf: now - 1,
    ...claims,
  })}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(message),
  )
  return `${message}.${Buffer.from(signature).toString('base64url')}`
}
function request(token?: string) {
  return new Request('https://cloud.example/api/events', {
    headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
  })
}
function certificates() {
  certs
    .mockReset()
    .mockImplementation(async () => Response.json({ keys: [{ ...jwk, kid: 'test' }] }))
  vi.stubGlobal('fetch', certs)
}

it('verifies RS256 claims and rejects malformed, missing and invalid tokens', async () => {
  certificates()
  expect(await admitsAccess(request(await signed()), config)).toBe(true)
  expect(certs).toHaveBeenCalledWith('https://test.cloudflareaccess.com/cdn-cgi/access/certs')
  for (const claims of [
    { aud: ['other'] },
    { iss: 'https://evil.example' },
    { exp: 1 },
    { nbf: Date.now() / 1000 + 60 },
  ])
    expect(await admitsAccess(request(await signed(claims)), config)).toBe(false)
  const valid = await signed()
  const parts = valid.split('.')
  parts[2] = Buffer.alloc(256).toString('base64url')
  for (const token of [parts.join('.'), 'malformed', undefined])
    expect(await admitsAccess(request(token), config)).toBe(false)
  expect(certs).toHaveBeenCalledTimes(1)
  expect(await admitsAccess(request(await signed({}, { kid: 'unknown' })), config)).toBe(false)
  expect(certs).toHaveBeenCalledTimes(2)
  expect(await admitsAccess(request(await signed({}, { alg: 'HS256' })), config)).toBe(false)
})

it('refuses empty config and only bypasses when explicitly set to 1', async () => {
  for (const env of [
    {},
    { ...config, ACCESS_AUD: '' },
    { ...config, ACCESS_TEAM_DOMAIN: '' },
    { ACCESS_DEV_BYPASS: '0' },
  ])
    expect(await admitsAccess(request(await signed()), env)).toBe(false)
  expect(await admitsAccess(request(), { ACCESS_DEV_BYPASS: '1' })).toBe(true)
})

it('fails closed when certificate retrieval fails', async () => {
  vi.stubGlobal('fetch', vi.fn<() => void>().mockRejectedValue(new Error('Unavailable')))
  expect(
    await admitsAccess(request(await signed()), {
      ...config,
      ACCESS_TEAM_DOMAIN: 'unavailable.cloudflareaccess.com',
    }),
  ).toBe(false)
})

it('passes valid JWTs and sync requests to the replica, but not assets through authentication', async () => {
  certificates()
  const forward = vi.fn<() => Response>(() => Response.json({ ok: true }))
  const env = {
    ...config,
    SYNC_TOKEN: 'synthetic-test-value',
    REPLICA: { idFromName: vi.fn<() => void>(), get: () => ({ fetch: forward }) },
    DIRECTORY: { idFromName: vi.fn<() => void>(), get: () => ({ fetch: forward }) },
    ASSETS: { fetch: forward },
  } as unknown as Parameters<typeof worker.fetch>[1]
  expect(
    (
      await worker.fetch(
        new Request('https://cloud.example/api/directory', {
          headers: { 'Cf-Access-Jwt-Assertion': await signed() },
        }),
        env,
      )
    ).status,
  ).toBe(200)
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
  try {
    expect(
      (
        await worker.fetch(
          new Request('https://cloud.example/sync?machine=test&project=/test', {
            headers: { Authorization: 'Bearer synthetic-test-value' },
          }),
          env,
        )
      ).status,
    ).toBe(200)
  } finally {
    Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
  }
  expect(
    (await worker.fetch(new Request('https://cloud.example/assets/test.js'), env)).status,
  ).toBe(200)
  expect(forward).toHaveBeenCalledTimes(3)
})

it('authenticates sync before validating parameters or touching a replica namespace', async () => {
  const idFromName = vi.fn<(name: string) => string>((name) => name)
  const get = vi.fn<() => { fetch: () => Response }>(() => ({ fetch: () => new Response() }))
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
  try {
    for (const token of [undefined, '', 'wrong-token']) {
      for (const query of ['?machine=scanner&project=/arbitrary', '']) {
        const response = await worker.fetch(
          new Request(`https://cloud.example/sync${query}`, {
            headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
          }),
          {
            SYNC_TOKEN: 'synthetic-test-value',
            REPLICA: { idFromName, get },
          } as unknown as Parameters<typeof worker.fetch>[1],
        )
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'Unauthorized' })
        expect(idFromName).not.toHaveBeenCalled()
        expect(get).not.toHaveBeenCalled()
      }
    }
    const response = await worker.fetch(
      new Request('https://cloud.example/sync?machine=scanner&project=/arbitrary', {
        headers: { Authorization: 'Bearer synthetic-test-value' },
      }),
      { REPLICA: { idFromName, get } } as unknown as Parameters<typeof worker.fetch>[1],
    )
    expect(response.status).toBe(401)
    expect(idFromName).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  } finally {
    Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
  }
})

it('refuses wrong, prefix-matching, empty and missing sync credentials', async () => {
  const replica = Object.assign(Object.create(ProjectReplica.prototype) as ProjectReplica, {
    env: { SYNC_TOKEN: 'synthetic-test-value' },
  })
  // Node WebCrypto lacks the Workers extension; use Node's equivalent constant-time primitive.
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
  try {
    for (const value of ['Bearer synthetic-test-valuf', 'Bearer synthetic-test', 'Bearer ', ''])
      expect(
        (
          await replica.fetch(
            new Request('https://cloud.example/sync', { headers: { Authorization: value } }),
          )
        ).status,
      ).toBe(401)
    expect(
      (
        await replica.fetch(
          new Request('https://cloud.example/sync', {
            headers: { Authorization: 'Bearer synthetic-test-value' },
          }),
        )
      ).status,
    ).toBe(426)
  } finally {
    Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
  }
})

it('refuses API requests without JWT before touching the Durable Object', async () => {
  const forward = vi.fn<() => Response>(() => Response.json({ private: true }))
  const get = vi.fn<() => { fetch: typeof forward }>(() => ({ fetch: forward }))
  const env = {
    REPLICA: { idFromName: vi.fn<() => void>(), get },
    ASSETS: { fetch: vi.fn<() => void>() },
    ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
    ACCESS_AUD: 'application',
  } as unknown as Parameters<typeof worker.fetch>[1]
  const response = await worker.fetch(new Request('https://cloud.example/api/events'), env)
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'Unauthorized' })
  expect(get).not.toHaveBeenCalled()
})
