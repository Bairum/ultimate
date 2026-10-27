import type { Context } from '@earendil-works/chord'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, HookApi } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { AdvisorStateDoc, Role, RoleStats, Timing } from './refs.ts'
import { recipient } from './refs.ts'
import { Runs, State } from './state.ts'

type Pending = { refs: Map<string, string>; changed?: Set<string>; loading?: Promise<void> }
const indexes = new WeakMap<ExtensionHost, Map<number, Pending>>()
export function invalidate(host: ExtensionHost, id: number) {
  indexes.get(host)?.delete(id)
}
export function stored(
  host: ExtensionHost,
  id: number,
  notes: { id: string; ref?: string }[],
  unread: boolean,
) {
  const row = indexes.get(host)?.get(id)
  if (!row) return
  for (const note of notes) {
    if (!note.ref) continue
    row.changed?.add(note.ref)
    if (unread) row.refs.set(note.ref, note.id)
    else row.refs.delete(note.ref)
  }
}
async function pending(host: ExtensionHost, id: ConversationId, context: Context) {
  let index = indexes.get(host)
  if (!index) indexes.set(host, (index = new Map()))
  let row = index.get(id)
  if (!row) {
    const initial: Pending = { refs: new Map(), changed: new Set() }
    index.set(id, initial)
    initial.loading = (async () => {
      const state = await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)
      for (const note of state?.notes ?? []) {
        if (
          recipient(note) === id &&
          note.ref &&
          note.delivered &&
          note.delivered !== 'card' &&
          note.readAt === undefined &&
          !note.response &&
          !initial.changed?.has(note.ref)
        )
          initial.refs.set(note.ref, note.id)
      }
      delete initial.changed
    })()
    row = initial
  }
  try {
    await row.loading
  } catch (error) {
    if (index.get(id) === row) index.delete(id)
    throw error
  }
  return row.refs
}
export async function trackRead(
  host: ExtensionHost,
  messages: readonly Message[],
  api: HookApi,
  context: Context,
) {
  const refs = await pending(host, api.conversationId, context)
  if (!refs.size) return undefined
  const text = messages
    .filter((m) => m.role === 'user')
    .flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])),
    )
    .join('\n')
  const found = [...refs].filter(([ref]) =>
    new RegExp(`<advisory\\b[^>]*\\bid="${ref}"`).test(text),
  )
  if (!found.length) return undefined
  await host.harness().commit(async (tx) => {
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
    const run = (await tx.doc(LiveDoc, api.conversationId)).run?.inputs[0]
    for (const [, id] of found) {
      const note = state.notes.find((n) => n.id === id)
      if (!note || !note.delivered || note.delivered === 'card' || note.readAt !== undefined)
        continue
      note.readAt = Date.now()
      if (run !== undefined) {
        runs.readRuns ??= {}
        runs.readRuns[id] = run
      }
    }
  }, context)
  for (const [ref] of found) refs.delete(ref)
  return undefined
}
export async function acknowledge(
  host: ExtensionHost,
  text: string,
  id: ConversationId,
  context: Context,
) {
  const matches = [
    ...text.matchAll(
      // Tolerates list markers, quotes and inline code around the line, as agents format replies.
      /^[\s>*\-•`]*advisor\s+`?([a-z0-9]+)`?\s*:\s*`?(addressed|deferred|disputed)`?\s*[—–\-:]\s*(.+)$/gim,
    ),
  ]
  if (!matches.length) return
  await host.harness().commit(async (tx) => {
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    for (const match of matches) {
      const note = state.notes.find(
        (n) =>
          recipient(n) === id &&
          n.ref === match[1].toLowerCase() &&
          n.delivered !== 'card' &&
          n.readAt !== undefined,
      )
      if (note)
        note.response = {
          status: match[2].toLowerCase() as 'addressed' | 'deferred' | 'disputed',
          source: 'ack',
          reason: match[3].trim().slice(0, 500),
          at: Date.now(),
        }
    }
  }, context)
}
export function stats(state: AdvisorStateDoc, since: number, timings: readonly Timing[] = []) {
  const roles: Partial<Record<Role, RoleStats>> = {}
  for (const note of state.notes) {
    if (note.at < since) continue
    const row = (roles[note.role] ??= {
      delivered: 0,
      read: 0,
      dismissed: 0,
      routed: 0,
      routedAddressed: 0,
      addressed: 0,
      deferred: 0,
      disputed: 0,
      ignored: 0,
      unread: 0,
      late: 0,
      pending: 0,
    })
    if (note.routedTo !== undefined) {
      row.routed++
      if (note.response?.status === 'addressed') row.routedAddressed++
    }
    if (note.closedBy === 'user' && note.status === 'dismissed') row.dismissed++
    if (note.delivered && note.delivered !== 'card') {
      row.delivered++
      if (note.readAt !== undefined) row.read++
      if (!note.response) row.pending++
    }
    if (note.response) row[note.response.status]++
  }
  return { since, roles, latency: latency(timings, since) }
}
/** Review durations per `role:point`, silent and skipped reviews included. */
function latency(timings: readonly Timing[], since: number) {
  const groups = Map.groupBy(
    timings.filter((t) => t.at >= since),
    (t) => `${t.role}:${t.point}`,
  )
  return Object.fromEntries(
    [...groups].map(([key, rows]) => {
      const ms = rows.map((t) => t.ms).toSorted((a, b) => a - b)
      const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))]
      return [key, { n: ms.length, p50: at(0.5), p90: at(0.9), max: ms[ms.length - 1] }]
    }),
  )
}
