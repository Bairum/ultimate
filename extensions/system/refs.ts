/**
 * System in the browser: one stream of everything Ultimate records (durable events and the call trace), paged and
 * filtered, and the call tree of one trace with its events. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** One recorded thing: a durable event or a traced call, in one shape. */
export type SystemRow = {
  /** `e<event id>` for an event, the call id for a call. */
  id: string
  source: 'event' | 'call'
  /** ISO time: when the event was emitted, or when the call started. */
  at: string
  /** `event` for an event; the call kind (`service`, `action`, `reactor`, `tool`, `model`, …) for a call. */
  kind: string
  /** The event name (`workspaces.landed`) or the call name (`alpha/go`, `bash`). */
  name: string
  conversation?: number
  trace?: string
  /** False for a failed call; events are always ok. */
  ok: boolean
  /** A call's duration in milliseconds. */
  ms?: number
  error?: string
  /** One short line: the event's data, or `caller → callee` and the call's arguments (redacted by the trace). */
  summary: string
}

/**
 * Filters of a stream: `sources` keeps events, calls or both (default both); `kinds` keeps event names and call kinds
 * (`['workspaces.landed', 'tool']`); `conversation` keeps rows of that conversation; `errors` keeps failed calls
 * only; `text` keeps rows whose name, caller, callee, arguments, error or event data contain it.
 */
export type SystemFilter = {
  sources?: ('event' | 'call')[]
  kinds?: string[]
  conversation?: number
  errors?: boolean
  text?: string
}

/**
 * `{ before?, after?, limit?, ...filter }` → `{ rows, next?, head }`: at most `limit` (default 200, at most 500)
 * matching rows, newest first, events and calls merged by time (a call by when it finished, as the trace records it).
 * Without a cursor, the newest rows. `before: next` pages back without gaps or repeats; `next` is absent once nothing
 * older is left. `after: head` follows live: the rows recorded since, newest first, at most `limit` of the oldest
 * ones, with a new `head` to follow from. Cursors are opaque; reuse them only with the same filter.
 */
export const StreamAction = actionRef<
  SystemFilter & { before?: string; after?: string; limit?: number },
  { rows: SystemRow[]; next?: string; head: string }
>('system', 'stream')

/** A traced call with the calls it made, in start order. */
export type SystemCall = SystemRow & { parent?: string; children: SystemCall[] }

/**
 * `{ trace }` → `{ calls, events }`: the call tree of trace `trace` (roots in start order, at most 5000 calls) and
 * the events emitted in it, oldest first.
 */
export const TreeAction = actionRef<
  { trace: string },
  { calls: SystemCall[]; events: SystemRow[] }
>('system', 'tree')
