import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { afterEach, expect, it } from 'vitest'
import { modelLogin, noLogin } from '../extensions/cloud/login.ts'
import {
  announce,
  cheapest,
  due,
  heartbeat,
  hostDeps,
  REPORT,
  responseEntry,
  shouldReport,
} from '../extensions/health/server.ts'
import type { HeartbeatDeps } from '../extensions/health/server.ts'
import healthExtension, { changedLogins, watchLogins } from '../extensions/health/server.ts'
import { actions as models } from '../extensions/models/server.ts'
import type { ActionContext } from '../server/actions.ts'
import {
  healthPath,
  merge,
  readHealth,
  record,
  reset,
  sanitize,
  state,
} from '../extensions/health/store.ts'
import type { HealthEntry } from '../extensions/health/store.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { prepareHarness } from '../server/harness.ts'
import { LoginChanged } from '../extensions/models/api.ts'
import { Changed as HealthChanged } from '../extensions/health/refs.ts'
import { apis, eventHost, removeTemps, temp, until } from './helpers.ts'

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

it('summarises errors to a status, error codes and known keywords', () => {
  expect(
    sanitize('400 {"error":"invalid_grant","error_description":"Refresh token revoked"}'),
  ).toBe('400 invalid_grant revoked')
  expect(sanitize('429 rate_limit_error: Too many requests')).toBe('429 rate_limit_error')
  expect(sanitize('Request failed with status 401: Unauthorized')).toBe('401 unauthorized')
  expect(sanitize('fetch failed: ECONNREFUSED 127.0.0.1:443')).toBe('ECONNREFUSED')
  expect(sanitize('Something odd happened')).toBe('request failed')
  expect(sanitize('a_b_c '.repeat(300))).toBe('request failed')
})

it('sanitises every credential format it can recognise, keeping provider error codes', () => {
  const secrets = [
    'authorization: bearer lowercaseSecret1',
    'Authorization: Basic dXNlcjpwYXNz',
    'refresh_token=rt.Abc123secret&x',
    '{"access_token":"opaqueSecret99"}',
    'api_key: plainSecret7',
    'x-api-key=keySecret8',
    'ghp_ghSecretValue1',
    'xoxb-slackSecret-2',
    'opaque 4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c',
    'cookie=sessionSecret3',
    'Cookie: session=cookieSecret4; other=val_secret_x',
    'password: "my Secret pass phrase"',
    'Invalid key sk-ant-api03-SECRETsecret_42 with eyJhbGciOi.x.y',
    'token lower_case_secret_value',
    // Review findings: a numeric password on its own line, a token whose parts look like snake_case.
    'Login rejected\npassword:\n429\n',
    'Bad credentials ghp_abcd_efgh',
    'my_secret_pass_word leaked',
  ]
  const leaked = secrets.filter((text) =>
    /secret|dXNlcjpwYXNz|4f9a8b7c6d5e|eyJ|pass|ghp|abcd|429/i.test(sanitize(text)),
  )
  expect(leaked).toEqual([])
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
      error: '401 invalid_grant',
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

it('reports after a ping, keeps retrying a failed report, and at least hourly', () => {
  const fresh = { reported: NOW, pending: false }
  expect(shouldReport(fresh, false, NOW + MINUTE)).toBe(false)
  expect(shouldReport(fresh, true, NOW + MINUTE)).toBe(true)
  // A report after a ping failed although an earlier one succeeded a minute ago: the next quiet tick retries.
  expect(shouldReport({ reported: NOW, pending: true }, false, NOW + 10 * MINUTE)).toBe(true)
  expect(shouldReport(fresh, false, NOW + REPORT)).toBe(true)
  // A resource made by the previous facet has no `pending` yet: it reads as nothing owed.
  expect(shouldReport({ reported: NOW }, false, NOW + MINUTE)).toBe(false)
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
    forget: async () => {},
  } as unknown as HeartbeatDeps
  expect(await heartbeat(deps)).toEqual({ pruned: [], pinged: ['anthropic', 'openai'] })
  expect(calls).toEqual(['anthropic/haiku', 'openai/mini'])
  expect(recorded).toEqual([
    ['anthropic', { lastChecked: NOW, lastOk: NOW }],
    ['openai', { lastChecked: NOW, lastFail: NOW, error: '401 Bearer abc.def' }],
  ])
})

it('heartbeat forgets providers without a login here, so their old failures stop warning', async () => {
  const home = await temp()
  await record(home, 'openai', { lastFail: NOW, lastChecked: NOW, error: 'invalid_grant' })
  await record(home, 'openai-codex', { lastOk: NOW, lastUsed: NOW })
  const pinged: string[] = []
  const deps: HeartbeatDeps = {
    ...hostDeps({ userHome: home } as unknown as ExtensionHost),
    now: () => NOW,
    models: {
      getAvailable: async () => [model('openai', 'mini', 1), model('openai-codex', 'mini', 1)],
      getProviderAuthStatus: (provider: string) => ({ configured: provider === 'openai-codex' }),
      completeSimple: async (used: { provider: string }) => {
        pinged.push(used.provider)
        return { stopReason: 'stop' }
      },
    } as unknown as HeartbeatDeps['models'],
  }
  expect(await heartbeat(deps)).toEqual({ pruned: ['openai'], pinged: [] })
  expect(pinged).toEqual([])
  expect((await readHealth(home)).map((entry) => [entry.provider, entry.state])).toEqual([
    ['openai-codex', 'ok'],
  ])
  // Nothing left to forget: the next tick changes nothing and owes no report.
  expect(await heartbeat(deps)).toEqual({ pruned: [], pinged: [] })
})

/** A login host whose `want` finds the health extension installed on the same user home and models. */
function withHealth<T extends Pick<ExtensionHost, 'userHome' | 'modelRuntime'>>(host: T) {
  const services = apis()
  // No login changes here, so its reactor is never started.
  healthExtension({
    ...host,
    ...services,
    faux: true,
    react: () => {},
  } as unknown as ExtensionHost)
  return { ...host, want: services.want }
}

it('a failing default provider is no model login for a move', async () => {
  const home = await temp()
  const host = withHealth({
    faux: undefined,
    userHome: home,
    settings: { getDefaultProvider: () => 'anthropic' } as unknown as ExtensionHost['settings'],
    modelRuntime: {
      getProviderAuthStatus: () => ({ configured: true }),
      getAvailable: async () => [],
    } as unknown as ExtensionHost['modelRuntime'],
  })
  const login = () => modelLogin(host)
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

it('a move confirms a recorded failure with a ping, so a stale one never blocks it', async () => {
  const home = await temp()
  let answers: 'stop' | 'error' = 'stop'
  const pinged: string[] = []
  const host = withHealth({
    faux: undefined,
    userHome: home,
    settings: { getDefaultProvider: () => 'anthropic' } as unknown as ExtensionHost['settings'],
    modelRuntime: {
      getProviderAuthStatus: () => ({ configured: true }),
      getAvailable: async () => [model('anthropic', 'haiku', 1)],
      completeSimple: async (pingedModel: { id: string }) => {
        pinged.push(pingedModel.id)
        return {
          stopReason: answers,
          errorMessage: answers === 'error' ? 'invalid_grant' : undefined,
        }
      },
    } as unknown as ExtensionHost['modelRuntime'],
  })
  // A failure long ago, no heartbeat since: the move's ping finds the provider working and clears it.
  await record(home, 'anthropic', { lastFail: NOW, error: 'overloaded' })
  expect(await modelLogin(host)).toMatchObject({ ok: false, error: 'overloaded' })
  expect(await modelLogin(host, { confirm: true })).toEqual({ provider: 'anthropic', ok: true })
  expect(pinged).toEqual(['haiku'])
  expect(await modelLogin(host)).toEqual({ provider: 'anthropic', ok: true })
  // A real revocation: the confirming ping fails too and its error blocks the move.
  answers = 'error'
  await record(home, 'anthropic', { lastFail: Date.now() + HOUR, error: 'overloaded' })
  expect(await modelLogin(host, { confirm: true })).toMatchObject({
    ok: false,
    error: expect.stringMatching(/invalid_grant|overloaded/),
  })
  expect(pinged).toEqual(['haiku', 'haiku'])
})

it('resets a provider whose login changed to unknown, so the next heartbeat pings it', async () => {
  const home = await temp('ultimate-health-reset-')
  await record(home, 'anthropic', { lastOk: NOW - MINUTE, lastFail: NOW, error: 'invalid_grant' })
  await record(home, 'openai-codex', { lastOk: NOW })
  await reset(home, ['anthropic'])
  const health = await readHealth(home)
  expect(health.map((entry) => [entry.provider, entry.state])).toEqual([['openai-codex', 'ok']])
  // With no entry, the provider is due at once even though the machine's interval has not passed.
  expect(due({ 'openai-codex': { lastOk: NOW } }, NOW, ['anthropic', 'openai-codex'])).toEqual([
    'anthropic',
  ])
})

it('names the providers whose login appeared or disappeared, not a refreshed one', () => {
  expect(changedLogins(new Set(['anthropic', 'openai']), new Set(['anthropic', 'claude']))).toEqual(
    ['claude', 'openai'],
  )
  expect(changedLogins(new Set(['anthropic']), new Set(['anthropic']))).toEqual([])
})

it('watches auth.json: a login added or removed in pi resets its health, a token refresh does not', async () => {
  const home = await temp('ultimate-health-watch-')
  const agent = join(home, '.pi/agent')
  await mkdir(agent, { recursive: true })
  const auth = join(agent, 'auth.json')
  await writeFile(auth, JSON.stringify({ anthropic: { refresh: 'a' } }))
  await record(home, 'anthropic', { lastFail: NOW, error: 'invalid_grant' })
  await record(home, 'openai-codex', { lastFail: NOW, error: 'invalid_grant' })
  const calls: boolean[] = []
  const stop = watchLogins(home, (providers) => calls.push(providers), auth, 0)
  try {
    // A refresh: same providers, new tokens, written by replacing the file as Pi does.
    await writeFile(`${auth}.tmp`, JSON.stringify({ anthropic: { refresh: 'b' } }))
    await rename(`${auth}.tmp`, auth)
    await until(() => calls.length > 0)
    expect(calls.at(-1)).toBe(false)
    expect((await readHealth(home)).map((entry) => entry.provider)).toEqual([
      'anthropic',
      'openai-codex',
    ])
    // A new login: that provider starts over; the other keeps its record.
    calls.length = 0
    await writeFile(auth, JSON.stringify({ anthropic: { refresh: 'b' }, 'openai-codex': {} }))
    await until(() => calls.includes(true))
    expect((await readHealth(home)).map((entry) => entry.provider)).toEqual(['anthropic'])
    // A logout.
    calls.length = 0
    await writeFile(auth, JSON.stringify({ 'openai-codex': {} }))
    await until(() => calls.includes(true))
    expect(await readHealth(home)).toEqual([])
  } finally {
    stop()
  }
})

it("Ultimate's logout resets the provider's health through models.login-changed", async () => {
  const home = await temp('ultimate-health-logout-')
  await record(home, 'anthropic', { lastFail: NOW, error: 'invalid_grant' })
  await record(home, 'openai-codex', { lastFail: NOW, error: 'invalid_grant' })
  const prepared = await prepareHarness({ home, ultimateRoot: home, userHome: home, faux: true })
  const opened = await prepared.open()
  try {
    const events = eventHost(() => opened.harness, 'health')
    const logouts: string[] = []
    const host = {
      userHome: home,
      faux: true,
      ...apis(),
      harness: () => opened.harness,
      emit: events.emit,
      react: events.react,
      modelRuntime: { logout: async (provider: string) => void logouts.push(provider) },
    } as unknown as ExtensionHost
    healthExtension(host)
    await events.start()
    await models.logout({ provider: 'anthropic' }, { host } as ActionContext)
    await until(events.settled)
    expect(logouts).toEqual(['anthropic'])
    expect((await readHealth(home)).map((entry) => entry.provider)).toEqual(['openai-codex'])
    // Every login change resets: the next logout reaches health as well.
    await models.logout({ provider: 'openai-codex' }, { host } as ActionContext)
    await until(events.settled)
    expect(await readHealth(home)).toEqual([])
    expect(
      (await events.eventLog.recent({ events: [LoginChanged] })).map((event) => event.data),
    ).toEqual([{ provider: 'openai-codex' }, { provider: 'anthropic' }])
    // Each reset flipped a failing provider to unknown: one event each, in the reactor's commit.
    expect(
      (await events.eventLog.recent({ events: [HealthChanged] })).map((event) => event.data),
    ).toEqual([
      { provider: 'openai-codex', state: 'unknown' },
      { provider: 'anthropic', state: 'unknown' },
    ])
    // A write is announced only when it flips the state.
    await announce(host, [await record(home, 'anthropic', { lastOk: NOW })])
    await announce(host, [await record(home, 'anthropic', { lastOk: NOW + 1 })])
    await announce(host, [
      await record(home, 'anthropic', { lastFail: NOW + 2, error: '401 key sk-secret' }),
    ])
    expect(
      (await events.eventLog.recent({ events: [HealthChanged], limit: 2 })).map(
        (event) => event.data,
      ),
    ).toEqual([
      { provider: 'anthropic', state: 'failing', error: '401' },
      { provider: 'anthropic', state: 'ok' },
    ])
    expect(await events.eventLog.recent({ events: [HealthChanged] })).toHaveLength(4)
  } finally {
    await opened.close()
  }
})
