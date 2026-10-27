import type { Context } from '@earendil-works/chord'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type {
  AdvisorNoteEntry,
  DeliveryReason,
  Role,
  RoleProfile,
  ReviewPoint,
  Threshold,
} from './refs.ts'
import { advisory, rank } from './render.ts'
import type { ReviewNote } from './render.ts'
import { State, Runs } from './state.ts'
import { stored } from './tracking.ts'
import { Subagents } from '../subagents/api.ts'
import { Started } from '../messages/api.ts'

function reaches(notes: ReviewNote[], threshold: Threshold | undefined) {
  return (
    threshold !== undefined &&
    threshold !== 'never' &&
    notes.some((n) => rank(n.severity) >= rank(threshold))
  )
}
/**
 * How a review's notes reach the reviewed agent, and why. `continued` says whether this run was already continued:
 * by an earlier review (`run`: the once-per-run cap) or by another advisor of this review (`review`: these notes
 * ride along with that continuation).
 */
export function route(
  role: Role,
  profile: RoleProfile,
  point: ReviewPoint,
  notes: ReviewNote[],
  lastInput: number | undefined,
  now: number,
  continued: 'run' | 'review' | undefined,
  ledgerActionable: boolean,
): { delivered: AdvisorNoteEntry['delivered']; reason: DeliveryReason } {
  if (role === 'ultimate')
    return { delivered: ledgerActionable ? 'note' : 'card', reason: 'default' }
  const quiet = lastInput !== undefined && now - lastInput < (profile.quietMs ?? 600_000)
  const continues = point === 'answer' && reaches(notes, profile.continueOn)
  const steers = point !== 'answer' && point !== 'idle' && reaches(notes, profile.steerOn)
  if (quiet && ((continues && !continued) || steers)) return { delivered: 'note', reason: 'quiet' }
  if (continues && !continued) return { delivered: 'continue', reason: 'continue' }
  if (steers) return { delivered: 'steer', reason: 'steer' }
  const delivered = profile.delivery ?? 'note'
  if (continues) return { delivered, reason: continued === 'review' ? 'continue' : 'cap' }
  return { delivered, reason: point === 'answer' ? 'threshold' : 'default' }
}
/**
 * The conversation that receives the reviewed one's answers: a subagent's owner, or the starter of a branch (a
 * coordinator's @ultimate). Undefined for everything else, @ultimate included: its parent is the user.
 */
export async function parentOf(tx: Tx, id: ConversationId) {
  const owner = (await tx.conversation(id))?.owner?.conversationId
  if (owner !== undefined)
    return (await tx.doc(Subagents, owner)).agents[String(id)] ? owner : undefined
  return (await tx.doc(Started, id)).by as ConversationId | undefined
}
/** What a routed review tells the parent: whose work it is about, and that the decision is the parent's. */
export function routedText(entry: AdvisorNoteEntry, from: number) {
  return `Advisor review of #${from}'s work (${entry.role}). #${from} has finished and will not see this, so it is yours to weigh: fix it, have it fixed, or dispute it.\n${advisory(entry.advisor, entry.notes)}`
}
export async function deliver(
  host: ExtensionHost,
  id: ConversationId,
  entry: AdvisorNoteEntry,
  context: Context,
  run?: number,
) {
  if (entry.routedTo !== undefined) return routeUp(host, id, entry, context)
  const conversation = await host.harness().conversation(id, context)
  if (!conversation) throw new Error('Advisor recipient unavailable')
  const requestId = `advisor:${entry.review}`
  // A replay after a crash finds the earlier placement: reuse it, since a steer later downgraded to a note would
  // reuse the request id with another submission type and be rejected.
  const placement = await place(host, id, id, entry, requestId, context)
  const placed = placement.placed
  entry = { ...entry, notes: placement.notes }
  if (!entry.notes.length) return undefined
  if (entry.delivered === 'steer' && !placed) {
    const live = await host.harness().snapshot(LiveDoc, id, context)
    if (!live?.run || live.run.inputs[0] !== run) entry = { ...entry, delivered: 'note' }
  }
  const content = advisory(entry.advisor, entry.notes)
  const draft = { kind: 'advisor.note', data: entry }
  // Writes permit an entry without model messages: cards never enter the model context.
  const submission =
    (placed && (await host.harness().submission(placed.id, context))) ||
    (entry.delivered === 'steer'
      ? await conversation.submit(
          { type: 'input', whenBusy: 'steer', requestId, entry: draft, content },
          context,
        )
      : await conversation.submit(
          {
            type: 'write',
            requestId,
            entry: {
              ...draft,
              ...(entry.delivered === 'note'
                ? { model: [{ role: 'user' as const, content, timestamp: Date.now() }] }
                : {}),
            },
          },
          context,
        ))
  const status = await submission.status(context)
  if (status.entry !== undefined)
    await host.harness().commit(async (tx) => {
      const state = await tx.doc(State, ROOT_CONVERSATION_ID)
      const ids = new Set(entry.notes.map((note) => note.id))
      for (const note of state.notes)
        if (note.conversation === id && ids.has(note.id)) {
          note.entry = status.entry
          note.delivered = entry.delivered
          if (entry.delivered === 'continue') {
            note.readAt ??= Date.now()
            if (run !== undefined) {
              const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
              runs.readRuns ??= {}
              runs.readRuns[note.id] = run
            }
          }
        }
    }, context)
  if (entry.delivered === 'continue' || entry.delivered === 'card')
    stored(host, id, entry.notes, false)
  return entry.delivered === 'continue' ? content : undefined
}
/** Drops notes the user dismissed before delivery; the earlier placement when this is a replay. */
function place(
  host: ExtensionHost,
  id: ConversationId,
  to: ConversationId,
  entry: AdvisorNoteEntry,
  requestId: string,
  context: Context,
) {
  return host.harness().commit(async (tx) => {
    const placed = await tx.submissionByRequest(to, requestId)
    if (placed) return { placed, notes: entry.notes }
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    const notes = entry.notes.filter((n) => {
      const note = state.notes.find((s) => s.id === n.id)
      if (note?.status !== 'dismissed') return true
      delete note.delivered
      stored(host, to, [note], false)
      return false
    })
    const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
    if (entry.delivered === 'continue') {
      runs.conversations[id] ??= { rounds: 0, signals: [] }
      const row = runs.conversations[id]
      const original = advisory(entry.advisor, entry.notes)
      row.continuations = (row.continuations ?? []).filter((text) => text !== original)
      if (notes.length) row.continuations.push(advisory(entry.advisor, notes))
    }
    if (runs.deliveries[entry.review]) {
      if (notes.length) runs.deliveries[entry.review] = { ...entry, notes }
      else delete runs.deliveries[entry.review]
    }
    return { placed, notes }
  }, context)
}
/**
 * Notes the reviewed agent can no longer act on: a card in its own transcript naming the parent, and the notes
 * themselves in the parent, as a passive note or, for a blocker on finished work, an input that wakes it.
 */
async function routeUp(
  host: ExtensionHost,
  id: ConversationId,
  entry: AdvisorNoteEntry,
  context: Context,
) {
  const to = entry.routedTo as ConversationId
  const parent = await host.harness().conversation(to, context)
  const child = await host.harness().conversation(id, context)
  if (!parent || !child) throw new Error('Advisor recipient unavailable')
  const requestId = `advisor:${entry.review}`
  const placement = await place(host, id, to, entry, requestId, context)
  entry = { ...entry, notes: placement.notes }
  if (!entry.notes.length) return undefined
  const card = await child.submit(
    {
      type: 'write',
      requestId: `${requestId}:card`,
      entry: { kind: 'advisor.note', data: entry },
    },
    context,
  )
  await card.status(context)
  const content = routedText(entry, id)
  const draft = { kind: 'advisor.note', data: { ...entry, from: id } }
  const submission =
    (placement.placed && (await host.harness().submission(placement.placed.id, context))) ||
    (entry.delivered === 'steer'
      ? await parent.submit(
          { type: 'input', whenBusy: 'steer', requestId, entry: draft, content },
          context,
        )
      : await parent.submit(
          {
            type: 'write',
            requestId,
            entry: {
              ...draft,
              model: [{ role: 'user' as const, content, timestamp: Date.now() }],
            },
          },
          context,
        ))
  const status = await submission.status(context)
  if (status.entry !== undefined)
    await host.harness().commit(async (tx) => {
      const state = await tx.doc(State, ROOT_CONVERSATION_ID)
      const ids = new Set(entry.notes.map((note) => note.id))
      for (const note of state.notes)
        if (note.conversation === id && ids.has(note.id)) {
          note.entry = status.entry
          note.delivered = entry.delivered
        }
    }, context)
  return undefined
}
