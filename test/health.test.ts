import { readFile } from 'node:fs/promises'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { afterEach, expect, it } from 'vitest'
import { modelLogin, noLogin } from '../extensions/cloud/login.ts'
import { cheapest, due, heartbeat, responseEntry } from '../extensions/health/server.ts'
import type { HeartbeatDeps } from '../extensions/health/server.ts'
import {
  healthPath,
  merge,
  readHealth,
  record,
  sanitize,
  state,
} from '../extensions/health/store.ts'
import type { HealthEntry } from '../extensions/health/store.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemps, temp } from './helpers.ts'

afterEach(removeTemps)

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = 1_000 * HOUR

const message = (stopReason: AssistantMessage['stopReason'], errorMessage?: string) =>
  ({ provider: 'anthropic', stopReason, errorMessage }) as AssistantMessage

it('computes a provider state from its latest success and failure', () => {
  expect(state({})).toBe('unknown')
  expect(state({ lastOk: 5 })).toBe('ok')
  expect(state({ lastOk: 5, lastFail: 6 })).toBe('failing')
  expect(state({ lastFail: 6 })).toBe('failing')
  expect(state({ lastOk: 7, lastFail: 6 })).toBe('ok')
})

it('merges each timestamp by its maximum and keeps the newest failure’s error', () => {
  expect(
    merge(
      { lastOk: 10, lastFail: 3, error: 'old', lastUsed: 10 },
      { lastOk: 4, lastFail: 8, error: 'new', lastChecked: 8 },
    ),
  ).toEqual({ lastOk: 10, lastFail: 8, error: 'new', lastChecked: 8, lastUsed: 10 })
  // An older failure arriving late does not replace the newer error.
  expect(merge({ lastFail: 8, error: 'new' }, { lastFail: 3, error: 'old' })).toEqual({
    lastFail: 8,
    error: 'new',
  })
})

it('sanitises errors: no token survives, whitespace collapses, 120 characters at most', () => {
  const error = sanitize(
    'Invalid key sk-ant-api03-SECRETsecret_42 sent\n\n  with Bearer abc.def-ghi and eyJhbGciOi.x.y',
  )
  expect(error).toBe('Invalid key … sent with … and …')
  expect(error).not.toContain('SECRET')
  expect(sanitize('x'.repeat(300))).toHaveLength(120)
})

it('records real responses in the machine’s health file, merging concurrent writes', async () => {
  const home = await temp()
  expect(responseEntry(message('aborted'), NOW)).toBeUndefined()
  expect(responseEntry(message('stop'), NOW)).toEqual({ lastOk: NOW, lastUsed: NOW })
  expect(responseEntry(message('toolUse'), NOW)).toEqual({ lastOk: NOW, lastUsed: NOW })
  const failed = responseEntry(message('error', '401 invalid_grant for sk-live-123abc'), NOW + 1)!
  expect(failed).toMatchObject({ lastFail: NOW + 1, lastUsed: NOW + 1 })

  await Promise.all([
    record(home, 'anthropic', responseEntry(message('stop'), NOW)!),
    record(home, 'anthropic', failed),
    record(home, 'openai', { lastOk: NOW }),
  ])
  expect(await readHealth(home)).toEqual([
    {
      provider: 'anthropic',
      state: 'failing',
      lastOk: NOW,
      lastFail: NOW + 1,
      lastUsed: NOW + 1,
      error: '401 invalid_grant for …',
    },
    { provider: 'openai', state: 'ok', lastOk: NOW },
  ])
  expect(await readFile(healthPath(home), 'utf8')).not.toContain('sk-live')
})

it('pings by activity: hourly while used, 4 h after 4 h idle, 8 h after 12 h, failures after 15 min', () => {
  const used = (idle: number, entry: HealthEntry = {}) => ({
    a: { lastUsed: NOW - idle, ...entry },
  })
  // Active machine: hourly.
  expect(due(used(MINUTE, { lastOk: NOW - 59 * MINUTE }), NOW, ['a'])).toEqual([])
  expect(due(used(MINUTE, { lastOk: NOW - HOUR }), NOW, ['a'])).toEqual(['a'])
  // A recent ping counts like a success.
  expect(
    due(used(MINUTE, { lastOk: NOW - 5 * HOUR, lastChecked: NOW - MINUTE }), NOW, ['a']),
  ).toEqual([])
  // Idle 4–12 h: every 4 h.
  expect(due(used(5 * HOUR, { lastOk: NOW - 3 * HOUR }), NOW, ['a'])).toEqual([])
  expect(due(used(5 * HOUR, { lastOk: NOW - 4 * HOUR }), NOW, ['a'])).toEqual(['a'])
  // Idle beyond 12 h, or never used: every 8 h.
  expect(due(used(13 * HOUR, { lastOk: NOW - 7 * HOUR }), NOW, ['a'])).toEqual([])
  expect(due(used(13 * HOUR, { lastOk: NOW - 8 * HOUR }), NOW, ['a'])).toEqual(['a'])
  expect(due({ a: { lastChecked: NOW - 7 * HOUR } }, NOW, ['a'])).toEqual([])
  // Never seen: due at once.
  expect(due({}, NOW, ['a', 'b'])).toEqual(['a', 'b'])
  // Failing: confirmed 15 min after the last ping, regardless of the interval.
  const failing = { lastOk: NOW - 2 * HOUR, lastFail: NOW - MINUTE, lastUsed: NOW - MINUTE }
  expect(due({ a: { ...failing, lastChecked: NOW - 14 * MINUTE } }, NOW, ['a'])).toEqual([])
  expect(due({ a: { ...failing, lastChecked: NOW - 15 * MINUTE } }, NOW, ['a'])).toEqual(['a'])
})

const model = (provider: string, id: string, input: number, output = input) => ({
  provider,
  id,
  cost: { input, output, cacheRead: 0, cacheWrite: 0 },
})

it('picks the cheapest model by input plus output cost, the first on a tie', () => {
  expect(
    cheapest([model('a', 'big', 15, 75), model('a', 'mini', 0.2, 0.8), model('a', 'flash', 0.6)])
      ?.id,
  ).toBe('mini')
  expect(cheapest([model('a', 'first', 1), model('a', 'second', 1)])?.id).toBe('first')
  expect(cheapest([])).toBeUndefined()
})

it('heartbeat pings each configured, due provider once with its cheapest model', async () => {
  const calls: string[] = []
  const recorded: [string, HealthEntry][] = []
  const deps = {
    now: () => NOW,
    models: {
      getAvailable: async () => [
        model('anthropic', 'opus', 15),
        model('anthropic', 'haiku', 1),
        model('openai', 'mini', 1),
        model('unconfigured', 'x', 0),
      ],
      getProviderAuthStatus: (provider: string) => ({ configured: provider !== 'unconfigured' }),
      completeSimple: async (pinged: { provider: string; id: string }) => {
        calls.push(`${pinged.provider}/${pinged.id}`)
        if (pinged.provider === 'openai') throw new Error('401 Bearer abc.def')
        return { stopReason: 'stop' }
      },
    },
    // Active machine (hourly); anthropic's last success is 2 h old, openai was never seen.
    read: async () => ({ anthropic: { lastOk: NOW - 2 * HOUR, lastUsed: NOW - 2 * HOUR } }),
    record: async (provider: string, entry: HealthEntry) => recorded.push([provider, entry]),
  } as unknown as HeartbeatDeps
  expect(await heartbeat(deps)).toEqual(['anthropic', 'openai'])
  expect(calls).toEqual(['anthropic/haiku', 'openai/mini'])
  expect(recorded).toEqual([
    ['anthropic', { lastChecked: NOW, lastOk: NOW }],
    ['openai', { lastChecked: NOW, lastFail: NOW, error: '401 Bearer abc.def' }],
  ])
})

it('a failing default provider is no model login for a move', async () => {
  const home = await temp()
  const login = () =>
    modelLogin({
      faux: undefined,
      userHome: home,
      settings: { getDefaultProvider: () => 'anthropic' } as unknown as ExtensionHost['settings'],
      modelRuntime: {
        getProviderAuthStatus: () => ({ configured: true }),
        getAvailable: async () => [],
      } as unknown as ExtensionHost['modelRuntime'],
    })
  expect(await login()).toEqual({ provider: 'anthropic', ok: true })
  await record(home, 'anthropic', { lastOk: NOW, lastFail: NOW + 1, error: 'invalid_grant' })
  const failing = await login()
  expect(failing).toEqual({ provider: 'anthropic', ok: false, error: 'invalid_grant' })
  expect(noLogin(failing.provider, failing.error)).toBe(
    'anthropic is failing here: invalid_grant; log in again with ⌘K → Log in',
  )
  await record(home, 'anthropic', { lastOk: NOW + 2 })
  expect(await login()).toEqual({ provider: 'anthropic', ok: true })
})
