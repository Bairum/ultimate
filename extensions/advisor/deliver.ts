import type { Context } from '@earendil-works/chord'
import type { ConversationId } from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { AdvisorNoteEntry, Role, RoleProfile, ReviewPoint, Threshold } from './refs.ts'
import { advisory, rank } from './render.ts'
import type { ReviewNote } from './render.ts'

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
  if (entry.delivered === 'steer') {
    const live = await host.harness().snapshot(LiveDoc, id, context)
    if (!live?.run || live.run.inputs[0] !== run) entry = { ...entry, delivered: 'note' }
  }
  const content = advisory(entry.advisor, entry.notes)
  const draft = { kind: 'advisor.note', data: entry }
  const requestId = `advisor:${entry.review}`
  // Writes permit an entry without model messages: cards never enter the model context.
  if (entry.delivered === 'steer')
    await conversation.submit(
      { type: 'input', whenBusy: 'steer', requestId, entry: draft, content },
      context,
    )
  else
    await conversation.submit(
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
    )
  return entry.delivered === 'continue' ? content : undefined
}
