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

/** One call inside a run: a tool call, or a model call (kind `model`). */
export type LaneCall = { at: string; ms: number; kind: string; name: string; ok: boolean }
/**
 * A stretch of work in one conversation: calls with at most 20 s of quiet between them. `end` is absent while the run
 * is open (its last call ended under 20 s ago, or the conversation has a live task). `more` counts calls past the 200
 * kept, which are the newest.
 */
export type LaneRun = { start: string; end?: string; ok: boolean; calls: LaneCall[]; more?: number }
/**
 * One conversation's runs, oldest first; agent, model, kind and parent from its `subagents.started` event, if any.
 * Titles are the browser's to resolve (`ConversationRef`).
 */
export type Lane = {
  conversation: number
  agent?: string
  model?: string
  kind?: 'standing' | 'branch' | 'child'
  parent?: number
  runs: LaneRun[]
}

/**
 * `{ since?, until? }` (ISO; default the last 30 minutes up to now) → `{ now, lanes, more? }`: a lane for each
 * conversation with tool or model calls in the window, most recently active first, at most 40; `more` counts the lanes
 * left out.
 */
export const LanesAction = actionRef<
  { since?: string; until?: string },
  { now: string; lanes: Lane[]; more?: number }
>('system', 'lanes')

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
