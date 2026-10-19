import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import { actions } from '../extensions/system/server.ts'
import type { SystemRow } from '../extensions/system/refs.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { callTrace } from '../server/trace.ts'
import type { EventRecord } from '../shared/events.ts'
import { fauxServer, linkDependencies, temp } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})
afterEach(() => {
  vi.restoreAllMocks()
})

const T0 = Date.parse('2026-10-19T12:00:00Z')
/** An in-memory event log with the semantics of `host.eventLog.recent`. */
function eventLog(events: EventRecord[]) {
  return {
    async recent(options: {
      events?: readonly { kind: string }[]
      since?: number
      before?: number
      order?: 'ascending' | 'descending'
      limit?: number
    }) {
      const kinds = options.events && new Set(options.events.map((event) => event.kind))
      const matching = events.filter(
        (event) =>
          (!kinds || kinds.has(event.kind)) &&
          (options.since === undefined || event.id > options.since) &&
          (options.before === undefined || event.id < options.before),
      )
      const ordered = options.order === 'ascending' ? matching : matching.toReversed()
      return structuredClone(ordered.slice(0, options.limit ?? 20))
    },
  }
}
const event = (
  id: number,
  name: string,
  seconds: number,
  data: JsonValue,
  context?: EventRecord['context'],
): EventRecord => ({
  id,
  name,
  kind: `event.${name}`,
  v: 1,
  at: new Date(T0 + seconds * 1000).toISOString(),
  data,
  ...(context ? { context } : {}),
})

/** A trace with calls at chosen seconds after T0, an event log, and the stream action over both. */
async function fixture(events: EventRecord[] = []) {
  const trace = callTrace(join(await temp(), 'trace.sqlite'))
  trace.open()
  const clock = vi.spyOn(performance, 'now')
  /** Record a call that starts at `seconds` and takes `ms`. */
  const call = (
    name: string,
    seconds: number,
    options: {
      kind?: string
      ms?: number
      fail?: string
      conversation?: number
      args?: unknown
    } = {},
  ) => {
    const start = T0 + seconds * 1000 - performance.timeOrigin
    clock.mockReturnValueOnce(start).mockReturnValueOnce(start + (options.ms ?? 0))
    const work = () => {
      if (options.fail) throw new Error(options.fail)
      return 'ok'
    }
    try {
      trace.run(
        {
          kind: (options.kind ?? 'service') as 'service',
          caller: 'a',
          callee: 'b',
          name,
          args: options.args,
          conversationId: options.conversation,
        },
        work,
        null,
      )
    } catch {
      // The failing call is the point; its row is what the test reads.
    }
  }
  const log = eventLog(events)
  const host = { trace: trace.reader, eventLog: log } as unknown as ExtensionHost
  const ctx = { host } as ActionContext
  const stream = (args: Record<string, unknown> = {}) =>
    actions.stream(args as JsonValue, ctx) as Promise<{
      rows: SystemRow[]
      next?: string
      head: string
    }>
  const tree = (traceId: string) => actions.tree({ trace: traceId }, ctx)
  return { trace, call, events, stream, tree }
}
const names = (rows: SystemRow[]) => rows.map((row) => row.name)

it('merges events and calls newest first, calls by when they finished', async () => {
  const f = await fixture([event(1, 'x.one', 1, { n: 1 }), event(5, 'x.two', 4, { n: 2 })])
  f.call('c.at2', 2)
  f.call('c.at3', 3)
  f.call('c.long', 0, { ms: 5000 }) // started first, finished (and so was written) last
  const { rows, next, head } = await f.stream()
  expect(names(rows)).toEqual(['c.long', 'x.two', 'c.at3', 'c.at2', 'x.one'])
  expect(next).toBeUndefined()
  expect(rows[1]).toMatchObject({
    id: 'e5',
    source: 'event',
    kind: 'event',
    ok: true,
    summary: '{"n":2}',
  })
  expect(rows[0]).toMatchObject({ source: 'call', kind: 'service', ok: true, ms: 5000 })
  expect(rows[0].summary).toBe('a → b')
  expect(head).toBe('5.3')
})

it('pages back with before without gaps or repeats, across both sources', async () => {
  const events = Array.from({ length: 23 }, (_, index) =>
    event(index * 2 + 1, 'x.tick', index * 3 + 1, { index }),
  )
  const f = await fixture(events)
  for (let index = 0; index < 37; index++) f.call(`c${index}`, index * 2)
  const everything = (await f.stream({ limit: 500 })).rows
  expect(everything).toHaveLength(60)
  const seen: SystemRow[] = []
  let before: string | undefined
  let pages = 0
  do {
    const page = await f.stream({ limit: 7, ...(before ? { before } : {}) })
    expect(page.rows.length).toBeLessThanOrEqual(7)
    seen.push(...page.rows)
    before = page.next
    pages++
  } while (before)
  expect(pages).toBe(9)
  expect(seen.map((row) => row.id)).toEqual(everything.map((row) => row.id))
  const times = seen.map((row) => Date.parse(row.at) + (row.ms ?? 0))
  expect(times).toEqual(times.toSorted((a, b) => b - a))
})

it('follows live with after: only what came since, oldest pages first when behind', async () => {
  const events = [event(1, 'x.one', 1, null)]
  const f = await fixture(events)
  f.call('c.old', 0)
  const { head } = await f.stream({ limit: 5 })
  expect((await f.stream({ after: head })).rows).toEqual([])
  events.push(event(2, 'x.two', 10, null))
  f.call('c.new', 11)
  const live = await f.stream({ after: head })
  expect(names(live.rows)).toEqual(['c.new', 'x.two'])
  expect((await f.stream({ after: live.head })).rows).toEqual([])
  // Seven new rows, read three at a time from the oldest: all arrive once.
  for (let index = 0; index < 4; index++) f.call(`c.burst${index}`, 20 + index * 2)
  for (let index = 0; index < 3; index++)
    events.push(event(3 + index, `x.burst${index}`, 21 + index * 2, null))
  const followed: string[] = []
  let cursor = live.head
  for (let round = 0; round < 3; round++) {
    const page = await f.stream({ after: cursor, limit: 3 })
    followed.unshift(...names(page.rows))
    cursor = page.head
  }
  expect(followed).toEqual([
    'c.burst3',
    'x.burst2',
    'c.burst2',
    'x.burst1',
    'c.burst1',
    'x.burst0',
    'c.burst0',
  ])
  expect((await f.stream({ after: cursor })).rows).toEqual([])
})

it('filters by source, kind, conversation, text and errors', async () => {
  const f = await fixture([
    event(1, 'x.landed', 1, { sha: 'abc' }, { conversationId: 7, traceId: 't' }),
    event(2, 'x.branched', 2, { id: 3 }),
  ])
  f.call('alpha/go', 3, { kind: 'action', conversation: 7, args: { q: 'needle' } })
  f.call('bash', 4, { kind: 'tool', conversation: 8 })
  f.call('beta.work', 5, { fail: 'exploded', conversation: 7 })
  expect(names((await f.stream({ sources: ['event'] })).rows)).toEqual(['x.branched', 'x.landed'])
  expect(names((await f.stream({ sources: ['call'] })).rows)).toEqual([
    'beta.work',
    'bash',
    'alpha/go',
  ])
  expect(names((await f.stream({ kinds: ['tool', 'x.landed'] })).rows)).toEqual([
    'bash',
    'x.landed',
  ])
  expect(names((await f.stream({ conversation: 7 })).rows)).toEqual([
    'beta.work',
    'alpha/go',
    'x.landed',
  ])
  expect(names((await f.stream({ text: 'NEEDLE' })).rows)).toEqual(['alpha/go'])
  expect(names((await f.stream({ text: 'abc' })).rows)).toEqual(['x.landed'])
  expect(names((await f.stream({ text: '%' })).rows)).toEqual([])
  const errors = (await f.stream({ errors: true })).rows
  expect(errors).toEqual([
    expect.objectContaining({ name: 'beta.work', ok: false, error: 'exploded' }),
  ])
  // Filters page too: one row a page, three pages.
  const first = await f.stream({ conversation: 7, limit: 1 })
  const second = await f.stream({ conversation: 7, limit: 1, before: first.next })
  const third = await f.stream({ conversation: 7, limit: 1, before: second.next })
  expect([first, second, third].map((page) => names(page.rows)[0])).toEqual([
    'beta.work',
    'alpha/go',
    'x.landed',
  ])
  expect(third.next).toBeUndefined()
})

it('rejects malformed arguments', async () => {
  const f = await fixture()
  await expect(f.stream({ limit: 501 })).rejects.toThrow('limit')
  await expect(f.stream({ before: 'yesterday' })).rejects.toThrow('Invalid before cursor')
  await expect(f.stream({ before: '1.1', after: '1.1' })).rejects.toThrow('not both')
  await expect(f.stream({ sources: ['task'] })).rejects.toThrow('sources')
  await expect(f.tree('')).rejects.toThrow('Expected { trace }')
})

// The real event log and action plumbing: `recent({ before, order })`, and a tree with the events emitted in it.
it('returns a trace tree with its events on a running server', async () => {
  const root = await temp('ultimate-system-')
  await linkDependencies(root)
  await mkdir(join(root, 'web'))
  await writeFile(
    join(root, 'vite.config.ts'),
    "export default { root: 'web', optimizeDeps: { noDiscovery: true } }",
  )
  await mkdir(join(root, 'extensions/alpha'), { recursive: true })
  await symlink(resolve('extensions/system'), join(root, 'extensions/system'))
  await writeFile(
    join(root, 'extensions/alpha/server.ts'),
    `import { defineEvent } from '${resolve('shared/events.ts')}'
const Pinged = defineEvent('alpha.pinged')
export default { name: 'alpha' }
export const actions = {
  ping: async (args, { host }) => host.harness().commit((tx) => host.emit(tx, Pinged, args), {}),
}`,
  )
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: root, home, userHome: home })
  servers.push(server)
  const signal = new AbortController().signal
  const invoke = (extension: string, action: string, args: JsonValue) =>
    server.extensions.invoke(extension, action, args, signal, 1)
  for (const n of [1, 2, 3]) await invoke('alpha', 'ping', { n })
  const stream = (await invoke('system', 'stream', { kinds: ['alpha.pinged', 'action'] })) as {
    rows: SystemRow[]
  }
  // Both sources newest first, merged by time (events carry millisecond times, so ties within one may interleave).
  const of = (source: string) =>
    stream.rows.filter((row) => row.source === source).map((row) => row.summary)
  expect(of('event')).toEqual(['{"n":3}', '{"n":2}', '{"n":1}'])
  expect(of('call')).toEqual(['ui → alpha  {"n":3}', 'ui → alpha  {"n":2}', 'ui → alpha  {"n":1}'])
  const times = stream.rows.map((row) => Date.parse(row.at) + (row.ms ?? 0))
  expect(times).toEqual(times.toSorted((a, b) => b - a))
  // Older than the newest event, calls used up: the middle event, then the first.
  const newest = stream.rows.find((row) => row.source === 'event')!.id.slice(1)
  const paged = (await invoke('system', 'stream', {
    sources: ['event'],
    limit: 1,
    before: `${newest}.0`,
  })) as { rows: SystemRow[]; next?: string }
  expect(paged.rows.map((row) => row.summary)).toEqual(['{"n":2}'])
  const last = (await invoke('system', 'stream', {
    sources: ['event'],
    limit: 1,
    before: paged.next!,
  })) as { rows: SystemRow[]; next?: string }
  expect(last.rows.map((row) => row.summary)).toEqual(['{"n":1}'])
  expect(last.next).toBeUndefined()
  // Following from the stream's head (ascending event reads): only the next ping.
  const head = ((await invoke('system', 'stream', { sources: ['event'] })) as { head: string }).head
  await invoke('alpha', 'ping', { n: 4 })
  const live = (await invoke('system', 'stream', { sources: ['event'], after: head })) as {
    rows: SystemRow[]
  }
  expect(live.rows.map((row) => row.summary)).toEqual(['{"n":4}'])
  const second = stream.rows.find((row) => row.source === 'event' && row.summary === '{"n":2}')!
  const tree = (await invoke('system', 'tree', { trace: second.trace! })) as {
    calls: { name: string; children: unknown[] }[]
    events: SystemRow[]
  }
  expect(tree.calls.map((call) => call.name)).toEqual(['alpha/ping'])
  expect(tree.events).toEqual([
    expect.objectContaining({ name: 'alpha.pinged', summary: '{"n":2}', conversation: 1 }),
  ])
})
