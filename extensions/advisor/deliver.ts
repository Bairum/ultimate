import type { Context } from '@earendil-works/chord'
import type { ConversationId } from '@earendil-works/pi-durable'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { AdvisorNoteEntry, Role, RoleProfile, ReviewPoint, Threshold } from './refs.ts'
import { advisory, rank } from './render.ts'
import type { ReviewNote } from './render.ts'
import { State, Runs } from './state.ts'
import { stored } from './tracking.ts'

function reaches(notes: ReviewNote[], threshold: Threshold | undefined) {
  return (
    threshold !== undefined &&
    threshold !== 'never' &&
    notes.some((n) => rank(n.severity) >= rank(threshold))
  )
}
export function route(
  role: Role,
  profile: RoleProfile,
  point: ReviewPoint,
  notes: ReviewNote[],
  lastInput: number | undefined,
  now: number,
  continued: boolean,
  ledgerActionable: boolean,
): AdvisorNoteEntry['delivered'] {
  if (role === 'ultimate') return ledgerActionable ? 'note' : 'card'
  const quiet = lastInput !== undefined && now - lastInput < (profile.quietMs ?? 600_000)
  const wouldContinue = point === 'answer' && !continued && reaches(notes, profile.continueOn)
  const wouldSteer = point !== 'answer' && point !== 'idle' && reaches(notes, profile.steerOn)
  if (quiet && (wouldContinue || wouldSteer)) return 'note'
  if (wouldContinue) return 'continue'
  if (wouldSteer) return 'steer'
  return profile.delivery ?? 'note'
}
export async function deliver(
  host: ExtensionHost,
  id: ConversationId,
  entry: AdvisorNoteEntry,
  context: Context,
  run?: number,
) {
  const conversation = await host.harness().conversation(id, context)
  if (!conversation) throw new Error('Advisor recipient unavailable')
  const requestId = `advisor:${entry.review}`
  // A replay after a crash finds the earlier placement: reuse it, since a steer later downgraded to a note would
  // reuse the request id with another submission type and be rejected.
  const placement = await host.harness().commit(async (tx) => {
    const placed = await tx.submissionByRequest(id, requestId)
    if (placed) return { placed, notes: entry.notes }
    const state = await tx.doc(State, ROOT_CONVERSATION_ID)
    const notes = entry.notes.filter(
      (n) => !state.notes.some((s) => s.id === n.id && s.status === 'dismissed'),
    )
    const runs = await tx.doc(Runs, ROOT_CONVERSATION_ID)
    if (runs.deliveries[entry.review]) {
      if (notes.length) runs.deliveries[entry.review] = { ...entry, notes }
      else delete runs.deliveries[entry.review]
    }
    return { placed, notes }
  }, context)
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
