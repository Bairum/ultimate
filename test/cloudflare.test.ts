import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import cloudflare, { secrets } from '../extensions/cloudflare/server.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { parseDefinition, definitionAgent } from '../extensions/subagents/agents.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of cleanup.splice(0)) await removeTemp(root)
})
const token = 'synthetic-cloudflare-credential'
const args = { worker: 'example-worker', from: 1000, to: 2000 }
async function fixture(key = true, enabled = true) {
  const root = await temp()
  cleanup.push(root)
  if (key) await writeSecret(root, 'CLOUDFLARE_API_TOKEN', token)
  const tool = cloudflare({
    userHome: root,
    extensions: () => (enabled ? [{ name: 'secrets', enabled: true, server: {} }] : []),
  } as unknown as ExtensionHost).tools![0]
  return {
    root,
    tool,
    run: async (input: unknown = args) => {
      const result = await tool.execute(
        input as never,
        {} as never,
        { abortSignal: new AbortController().signal } as never,
      )
      return (result.output![0] as { text: string }).text
    },
  }
}
function mock(
  result: unknown = { events: { count: 0, events: [] } },
  accounts = [{ id: 'account-one' }],
) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
    Response.json({
      success: true,
      result: url.includes('/accounts?') ? accounts : result,
    }),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}
it('declares a secret and a deferred tool; sends the documented query and bearer auth', async () => {
  const f = await fixture()
  const fetch = mock()
  expect(secrets[0]?.name).toBe('CLOUDFLARE_API_TOKEN')
  expect(f.tool.deferred).toBe(true)
  await f.run({ ...args, view: 'errors', search: 'failure', traceId: 'trace', limit: 3 })
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.cloudflare.com/client/v4/accounts?per_page=50')
  const [url, init] = fetch.mock.calls[1]
  expect(url).toBe(
    'https://api.cloudflare.com/client/v4/accounts/account-one/workers/observability/telemetry/query',
  )
  expect(init).toMatchObject({
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(JSON.parse(init!.body as string)).toEqual({
    queryId: 'ultimate-observability',
    timeframe: { from: 1000, to: 2000 },
    view: 'events',
    limit: 3,
    chart: false,
    ignoreSeries: true,
    parameters: {
      filterCombination: 'and',
      filters: [
        { key: '$metadata.service', operation: 'eq', type: 'string', value: 'example-worker' },
        { key: '$metadata.level', operation: 'eq', type: 'string', value: 'error' },
        { key: '$metadata.traceId', operation: 'eq', type: 'string', value: 'trace' },
      ],
      needle: { value: 'failure', isRegex: false, matchCase: false },
    },
  })
})
it('selects among accounts from user settings only and refuses ambiguity', async () => {
  const f = await fixture()
  const fetch = mock(undefined, [{ id: 'a' }, { id: 'b' }])
  await expect(f.run()).rejects.toThrow('cloud.accountId')
  expect(fetch).toHaveBeenCalledTimes(1)
  await mkdir(join(f.root, '.ultimate'), { recursive: true })
  await writeFile(
    join(f.root, '.ultimate/settings.json'),
    JSON.stringify({ cloud: { accountId: 'b' } }),
  )
  await f.run()
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('/accounts/b/workers/')
  await writeFile(
    join(f.root, '.ultimate/settings.json'),
    JSON.stringify({ cloud: { accountId: 'not-visible' } }),
  )
  await expect(f.run()).rejects.toThrow('cloud.accountId')
})
it('names the missing secret, location and required permission without making requests', async () => {
  const fetch = mock()
  for (const f of [await fixture(false), await fixture(true, false)]) {
    await expect(f.run()).rejects.toThrow('CLOUDFLARE_API_TOKEN in ⌘K → Secrets')
    await expect(f.run()).rejects.toThrow('Workers Observability Write')
  }
  expect(fetch).not.toHaveBeenCalled()
})
it('rejects reversed time windows before fetching', async () => {
  const f = await fixture()
  const fetch = mock()
  await expect(f.run({ ...args, from: 3000 })).rejects.toThrow('from must be earlier')
  expect(fetch).not.toHaveBeenCalled()
})
it('sorts, summarizes and bounds output, strips URL queries and redacts before truncating', async () => {
  const f = await fixture()
  mock({
    events: {
      count: 200,
      events: Array.from({ length: 100 }, (_, timestamp) => ({
        timestamp,
        $metadata: {
          message: `${'x'.repeat(490)}${token}${'y'.repeat(1000)}`,
          level: 'error',
          url: 'https://example.com/sync?private=value',
          statusCode: 500,
          duration: 12,
          traceId: 'trace',
        },
      })),
    },
  })
  const raw = await f.run({ ...args, limit: 50 })
  expect(raw).not.toContain(token)
  expect(raw).not.toContain('synthetic-')
  expect(raw).not.toContain('private=value')
  expect(raw.length).toBeLessThanOrEqual(16000)
  const result = JSON.parse(raw)
  expect(result).toMatchObject({ matched: 200, received: 100, truncated: true })
  expect(result.shown).toBeLessThan(50)
  expect(result.events[0]).toMatchObject({
    timestamp: 99,
    level: 'error',
    path: '/sync',
    status: 500,
    duration: 12,
    traceId: 'trace',
  })
  expect(result.events[0].message.length).toBeLessThanOrEqual(500)
})
it('formats native invocations and traces', async () => {
  const f = await fixture()
  const fetch = mock({
    invocations: { request: [{ timestamp: 1, $metadata: { message: 'invoked' } }] },
  })
  expect(JSON.parse(await f.run({ ...args, view: 'invocations' }))).toMatchObject({
    matched: 1,
    events: [{ message: 'invoked' }],
  })
  expect(JSON.parse(fetch.mock.calls[1][1]!.body as string).view).toBe('invocations')
  mock({
    traces: [
      { rootSpanName: 'fetch', traceStartMs: 5, traceDurationMs: 9, spans: 2, traceId: 't' },
    ],
  })
  expect(JSON.parse(await f.run({ ...args, view: 'traces' }))).toMatchObject({
    events: [{ timestamp: 5, message: 'fetch', duration: 9, spans: 2, traceId: 't' }],
  })
})
it('never echoes credentials from API failures, parse failures or fetch exceptions', async () => {
  const f = await fixture()
  for (const response of [
    () => new Response(token, { status: 403 }),
    () => Response.json({ success: false, errors: [{ code: 1, message: `bad ${token}` }] }),
    () => new Response(token),
    () => {
      throw new Error(token)
    },
  ]) {
    vi.stubGlobal('fetch', vi.fn(response))
    const error = await f.run().catch((caught: unknown) => String(caught))
    expect(error).toContain('Cloudflare account lookup failed')
    expect(error).not.toContain(token)
  }
})
it('redacts a token that a truncated Cloudflare error message would cut through', async () => {
  const f = await fixture()
  // The token straddles the 200-character cut: truncating first would leave its first half behind.
  const message = `${'x'.repeat(190)}${token}`
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ success: false, errors: [{ code: 1, message }] }, { status: 400 }),
    ),
  )
  const error = await f.run().catch((caught: unknown) => String(caught))
  expect(error).toContain('Cloudflare account lookup failed with HTTP 400')
  expect(error).not.toContain(token.slice(0, 10))
})
it('names the failing step, HTTP status and Cloudflare error codes', async () => {
  const f = await fixture()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/accounts?')
        ? Response.json({ success: true, result: [{ id: 'account-one' }] })
        : Response.json(
            { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
            { status: 403 },
          ),
    ),
  )
  const error = await f.run().catch((caught: unknown) => String(caught))
  expect(error).toContain(
    'Cloudflare telemetry query failed with HTTP 403 (10000: Authentication error)',
  )
})
it('parses the resident definition and enables its deferred tool', async () => {
  const path = '.ultimate/agents/cloudflare.md'
  const definition = parseDefinition(await readFile(path, 'utf8'), path)
  expect(definition).toMatchObject({
    name: 'cloudflare',
    resident: true,
    model: 'openai/gpt-6.1-sol',
    thinking: 'high',
  })
  expect(definition.tools).toEqual([
    'read',
    'bash',
    'codemode',
    'message',
    'note',
    'web_search',
    'web_fetch',
    'edit',
    'write',
    'automation',
    'cloudflare_observability',
  ])
  const { tool } = await fixture(false)
  const configured = definitionAgent(
    { ...definition, model: undefined },
    { tools: [], deferred: [tool], extensions: [] } as never,
    {} as never,
  )
  expect(configured.modelTools).toEqual({ add: [tool] })
})
