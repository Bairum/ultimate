import type { Context } from '@earendil-works/chord'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, HookApi } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { AdvisorStateDoc, Role, RoleStats } from './refs.ts'
import { Runs, State } from './state.ts'

const indexes = new WeakMap<ExtensionHost, Map<number, Map<string, string>>>()
export function invalidate(host: ExtensionHost, id: number) {
  indexes.get(host)?.delete(id)
}
export function stored(
  host: ExtensionHost,
  id: number,
  notes: { id: string; ref?: string }[],
  unread: boolean,
) {
  const refs = indexes.get(host)?.get(id)
  if (!refs) return
  for (const note of notes) {
    if (!note.ref) continue
    if (unread) refs.set(note.ref, note.id)
    else refs.delete(note.ref)
  }
}
async function pending(host: ExtensionHost, id: ConversationId, context: Context) {
  let index = indexes.get(host)
  if (!index) indexes.set(host, (index = new Map()))
  let refs = index.get(id)
  if (!refs) {
    const state = await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)
    refs = new Map(
      (state?.notes ?? [])
        .filter(
          (n) =>
            n.conversation === id &&
            n.ref &&
            n.delivered !== 'card' &&
            n.readAt === undefined &&
            !n.response,
        )
        .map((n) => [n.ref!, n.id]),
    )
    index.set(id, refs)
  }
  return refs
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
      if (!note || note.readAt !== undefined) continue
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
      /^\s*advisor ([a-z0-9]+):\s*(addressed|deferred|disputed)\s*[—\-:]\s*(.+)$/gim,
    ),
  ]
  if (!matches.length) return
  await host.harness().commit(async (tx) => {
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    for (const match of matches) {
      const note = state.notes.find(
        (n) =>
          n.conversation === id &&
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
export function stats(state: AdvisorStateDoc, since: number) {
  const roles: Partial<Record<Role, RoleStats>> = {}
  for (const note of state.notes) {
    if (note.at < since) continue
    const row = (roles[note.role] ??= {
      delivered: 0,
      read: 0,
      dismissed: 0,
      addressed: 0,
      deferred: 0,
      disputed: 0,
      ignored: 0,
      unread: 0,
      late: 0,
      pending: 0,
    })
    if (note.closedBy === 'user' && note.status === 'dismissed') row.dismissed++
    if (note.delivered && note.delivered !== 'card') {
      row.delivered++
      if (note.readAt !== undefined) row.read++
      if (!note.response) row.pending++
    }
    if (note.response) row[note.response.status]++
  }
  return { since, roles }
}
