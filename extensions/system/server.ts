import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { implementAction } from '../../lib/actions.ts'
import { defineEvent } from '../../shared/events.ts'
import type { EventRecord } from '../../shared/events.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { CallRow, CallTree } from '../../server/trace.ts'
import { LanesAction, StreamAction, TreeAction } from './refs.ts'
import type { Lane, SystemCall, SystemFilter, SystemRow } from './refs.ts'

const SUMMARY = 200
const cut = (text: string) => (text.length > SUMMARY ? `${text.slice(0, SUMMARY - 1)}…` : text)

function eventRow(event: EventRecord): SystemRow {
  return {
    id: `e${event.id}`,
    source: 'event',
    at: event.at,
    kind: 'event',
    name: event.name,
    ...(event.context?.conversationId === undefined
      ? {}
      : { conversation: event.context.conversationId }),
    ...(event.context?.traceId === undefined ? {} : { trace: event.context.traceId }),
    ok: true,
    summary: cut(JSON.stringify(event.data) ?? ''),
  }
}
function callRow(call: CallRow): SystemRow {
  return {
    id: call.id,
    source: 'call',
    at: call.at,
    kind: call.kind,
    name: call.name,
    ...(call.conversation === undefined ? {} : { conversation: call.conversation }),
    trace: call.trace,
    ok: call.ok,
    ms: call.ms,
    ...(call.error === undefined ? {} : { error: call.error }),
    // An action called without arguments stores `null`, which says nothing.
    summary: cut(
      [`${call.caller} → ${call.callee}`, call.args === 'null' ? undefined : call.args]
        .filter(Boolean)
        .join('  '),
    ),
  }
}

/** Where a page stopped in each source: an event id and a trace position, exclusive; 0 when nothing is left. */
type Cursor = { e: number; c: number }
const encode = (cursor: Cursor) => `${cursor.e}.${cursor.c}`
function decode(text: unknown, name: string): Cursor | undefined {
  if (text === undefined) return undefined
  const match = typeof text === 'string' ? /^(\d+)\.(\d+)$/.exec(text) : null
  if (!match) throw new Error(`Invalid ${name} cursor: ${JSON.stringify(text)}`)
  return { e: Number(match[1]), c: Number(match[2]) }
}

/** A row ready to merge: its source position and the time it sorts by (a call's by when it finished). */
type Item = { row: SystemRow; position: number; time: number }

function strings(value: unknown, name: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(`Expected ${name} to be a list of strings`)
  return value
}

function filterOf(args: Record<string, unknown>): SystemFilter {
  const sources = strings(args.sources, 'sources') as SystemFilter['sources']
  if (sources?.some((source) => source !== 'event' && source !== 'call'))
    throw new Error('Expected sources to name "event" or "call"')
  const kinds = strings(args.kinds, 'kinds')
  const { conversation, errors, text } = args
  if (conversation !== undefined && !Number.isInteger(conversation))
    throw new Error('Expected conversation to be an integer')
  if (errors !== undefined && typeof errors !== 'boolean')
    throw new Error('Expected errors to be a boolean')
  if (text !== undefined && typeof text !== 'string')
    throw new Error('Expected text to be a string')
  return {
    ...(sources ? { sources } : {}),
    ...(kinds ? { kinds } : {}),
    ...(conversation === undefined ? {} : { conversation: conversation as number }),
    ...(errors ? { errors } : {}),
    ...(text ? { text } : {}),
  }
}

/** At most `limit` matching events after (ascending) or before (descending) event id `from`. */
async function events(
  host: ExtensionHost,
  filter: SystemFilter,
  from: number,
  ascending: boolean,
  limit: number,
): Promise<Item[]> {
  const tokens = filter.kinds?.map((name) => defineEvent(name))
  const text = filter.text?.toLowerCase()
  const found: Item[] = []
  let position = from
  for (;;) {
    const page = await host.eventLog.recent({
      ...(tokens ? { events: tokens } : {}),
      ...(ascending ? { since: position, order: 'ascending' } : { before: position }),
      limit,
    })
    for (const event of page) {
      position = event.id
      if (
        filter.conversation !== undefined &&
        event.context?.conversationId !== filter.conversation
      )
        continue
      if (text && !`${event.name} ${JSON.stringify(event.data)}`.toLowerCase().includes(text))
        continue
      found.push({ row: eventRow(event), position: event.id, time: Date.parse(event.at) })
      if (found.length === limit) return found
    }
    if (page.length < limit) return found
  }
}

/** At most `limit` matching calls after (ascending) or before (descending) trace position `from`. */
function calls(
  host: ExtensionHost,
  filter: SystemFilter,
  from: number,
  ascending: boolean,
  limit: number,
) {
  const page = host.trace.page({
    ...(ascending ? { after: from } : { before: from }),
    ...(filter.kinds ? { kinds: filter.kinds } : {}),
    ...(filter.conversation === undefined ? {} : { conversation: filter.conversation }),
    ...(filter.errors ? { errors: true } : {}),
    ...(filter.text ? { text: filter.text } : {}),
    limit,
  })
  return {
    found: page.rows.map((call): Item => ({
      row: callRow(call),
      position: call.seq,
      time: Date.parse(call.at) + call.ms,
    })),
    last: page.last,
  }
}

/** Newest first; equal times by id, so the order is total. */
const newer = (a: Item, b: Item) => b.time - a.time || (a.row.id < b.row.id ? 1 : -1)

/**
 * Up to `limit` items of two lists, each in its source's order, taking the head that comes first by `first`: each
 * source gives a prefix of its list, so a cursor per source (its last item taken) resumes without gaps or repeats.
 */
function merge(a: Item[], b: Item[], limit: number, first: (x: Item, y: Item) => number) {
  const taken: Item[] = []
  let i = 0
  let j = 0
  while (taken.length < limit && (i < a.length || j < b.length))
    taken.push(j >= b.length || (i < a.length && first(a[i], b[j]) <= 0) ? a[i++] : b[j++])
  return { taken, a: i, b: j }
}

/**
 * Where a source resumes after `took` of its `found` items: its last item taken, `from` if none, `end` once all are
 * taken. Each source reads one item past the limit, so all taken means nothing further matched.
 */
const resume = (found: Item[], took: number, from: number, end: number) =>
  took === found.length ? end : took ? found[took - 1].position : from

async function stream(host: ExtensionHost, args: Record<string, unknown>) {
  const filter = filterOf(args)
  const limit = args.limit === undefined ? 200 : Number(args.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('Expected limit to be an integer from 1 to 500')
  const before = decode(args.before, 'before')
  const after = decode(args.after, 'after')
  if (before && after) throw new Error('Give before or after, not both')
  const wantEvents = (!filter.sources || filter.sources.includes('event')) && !filter.errors
  const wantCalls = !filter.sources || filter.sources.includes('call')
  // The newest event id, read first so a live follower never skips one appended meanwhile.
  const latest = (await host.eventLog.recent({ limit: 1 }))[0]?.id ?? 0

  if (after) {
    // The oldest rows since the cursor, so a follower that falls behind catches up page by page.
    const fromEvents = wantEvents ? await events(host, filter, after.e, true, limit + 1) : []
    const fromCalls = wantCalls ? calls(host, filter, after.c, true, limit + 1) : undefined
    const end = fromCalls?.last ?? host.trace.page({ limit: 1 }).last
    const merged = merge(fromEvents, fromCalls?.found ?? [], limit, (x, y) => newer(y, x))
    // An event appended after `latest` was read may be among those found.
    const newest = Math.max(after.e, latest, fromEvents.at(-1)?.position ?? 0)
    const head = {
      e: resume(fromEvents, merged.a, after.e, newest),
      c: resume(fromCalls?.found ?? [], merged.b, after.c, Math.max(after.c, end)),
    }
    return { rows: merged.taken.map((item) => item.row).toReversed(), head: encode(head) }
  }

  const start = before ?? { e: latest + 1, c: Number.MAX_SAFE_INTEGER }
  const fromEvents =
    wantEvents && start.e > 0 ? await events(host, filter, start.e, false, limit + 1) : []
  const fromCalls =
    wantCalls && start.c > 0 ? calls(host, filter, start.c, false, limit + 1) : undefined
  const merged = merge(fromEvents, fromCalls?.found ?? [], limit, newer)
  const next = {
    e: resume(fromEvents, merged.a, start.e, 0),
    c: resume(fromCalls?.found ?? [], merged.b, start.c, 0),
  }
  const head = { e: latest, c: fromCalls?.last ?? host.trace.page({ limit: 1 }).last }
  return {
    rows: merged.taken.map((item) => item.row),
    ...(next.e || next.c ? { next: encode(next) } : {}),
    head: encode(head),
  }
}

/** Every event emitted in trace `trace`, oldest first. */
async function traceEvents(host: ExtensionHost, trace: string) {
  const found: SystemRow[] = []
  let before: number | undefined
  for (;;) {
    const page = await host.eventLog.recent({
      ...(before === undefined ? {} : { before }),
      limit: 500,
    })
    for (const event of page) if (event.context?.traceId === trace) found.push(eventRow(event))
    if (page.length < 500) return found.toReversed()
    before = page.at(-1)!.id
  }
}

const node = (call: CallTree): SystemCall => ({
  ...callRow(call),
  ...(call.parent === undefined ? {} : { parent: call.parent }),
  children: call.children.map(node),
})

const QUIET = 20_000
const LANES = 40
const CALLS = 200

/** Agent facts by conversation, from `subagents.started` events (newest wins). */
async function started(host: ExtensionHost) {
  const Started = defineEvent<Record<string, JsonValue>>('subagents.started')
  const facts = new Map<number, Omit<Lane, 'conversation' | 'runs'>>()
  let before: number | undefined
  for (;;) {
    const page = await host.eventLog.recent({
      events: [Started],
      ...(before === undefined ? {} : { before }),
      limit: 500,
    })
    for (const { data } of page) {
      if (typeof data.id !== 'number' || facts.has(data.id)) continue
      const kind = data.kind
      facts.set(data.id, {
        ...(typeof data.agent === 'string' ? { agent: data.agent } : {}),
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
        ...(kind === 'standing' || kind === 'branch' || kind === 'child' ? { kind } : {}),
        ...(typeof data.parent === 'number' ? { parent: data.parent } : {}),
      })
    }
    if (page.length < 500) return facts
    before = page.at(-1)!.id
  }
}

/** Conversations with a live foreground task. */
async function busy(host: ExtensionHost) {
  const graph = await host.harness().taskGraph(BACKGROUND_CONTEXT)
  try {
    return new Set(
      Object.values(graph.value.tasks)
        .filter((task) => !task.background)
        .map((task) => task.conversationId as number),
    )
  } finally {
    graph.dispose()
  }
}

function time(value: unknown, name: string) {
  if (value === undefined) return undefined
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (Number.isNaN(parsed)) throw new Error(`Expected ${name} to be an ISO time`)
  return parsed
}

/** The lanes of `args`'s window as of `clock`; exported for tests, which set the clock. */
export async function lanes(
  host: ExtensionHost,
  args: Record<string, unknown>,
  clock = Date.now(),
) {
  const until = time(args.until, 'until') ?? clock
  const since = time(args.since, 'since') ?? until - 30 * 60_000
  if (since >= until) throw new Error('Expected since before until')
  // Each conversation's tool and model calls in the window, by start time.
  const byConversation = new Map<number, CallRow[]>()
  let after = 0
  for (;;) {
    const { rows } = host.trace.page({ after, since, until, kinds: ['tool', 'model'], limit: 1000 })
    for (const call of rows) {
      if (call.conversation === undefined) continue
      const list = byConversation.get(call.conversation)
      if (list) list.push(call)
      else byConversation.set(call.conversation, [call])
    }
    if (rows.length < 1000) break
    after = rows.at(-1)!.seq
  }
  const live = until >= clock ? await busy(host) : new Set<number>()
  const facts = byConversation.size ? await started(host) : new Map()
  const all = [...byConversation].map(([conversation, found]) => {
    found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    const runs: { start: number; end: number; calls: CallRow[] }[] = []
    for (const call of found) {
      const start = Date.parse(call.at)
      const run = runs.at(-1)
      if (run && start - run.end <= QUIET) {
        run.calls.push(call)
        run.end = Math.max(run.end, start + call.ms)
      } else runs.push({ start, end: start + call.ms, calls: [call] })
    }
    const last = runs.at(-1)!
    const open = until >= clock && (clock - last.end < QUIET || live.has(conversation))
    const lane: Lane = {
      conversation,
      ...facts.get(conversation),
      runs: runs.map((run) => ({
        start: new Date(run.start).toISOString(),
        ...(open && run === last ? {} : { end: new Date(run.end).toISOString() }),
        ok: run.calls.every((call) => call.ok),
        calls: run.calls.slice(0, CALLS).map((call) => ({
          at: call.at,
          ms: call.ms,
          kind: call.kind,
          name: call.name,
          ok: call.ok,
          trace: call.trace,
        })),
        ...(run.calls.length > CALLS ? { more: run.calls.length - CALLS } : {}),
      })),
    }
    return { lane, active: open ? Number.POSITIVE_INFINITY : last.end }
  })
  all.sort((a, b) => b.active - a.active || b.lane.conversation - a.lane.conversation)
  return {
    now: new Date(clock).toISOString(),
    lanes: all.slice(0, LANES).map((item) => item.lane),
    ...(all.length > LANES ? { more: all.length - LANES } : {}),
  }
}

const record = (args: unknown): Record<string, unknown> =>
  args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}

export const actions = {
  stream: implementAction(StreamAction, (args, { host }) => stream(host, record(args))),
  lanes: implementAction(LanesAction, (args, { host }) => lanes(host, record(args))),
  tree: implementAction(TreeAction, async (args, { host }) => {
    const trace = record(args).trace
    if (typeof trace !== 'string' || !trace) throw new Error('Expected { trace }')
    return { calls: host.trace.tree(trace).map(node), events: await traceEvents(host, trace) }
  }),
}

export default { name: 'system' }
