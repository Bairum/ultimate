import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { InboxDoc } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryId,
  Harness,
  SubmissionId,
  SubmissionRecord,
} from '@earendil-works/pi-durable'
import type { AgentOrigin } from './message-types.ts'

/** Batch fork-aware history and scoped reporter scans, never scan history per row. */
export async function provenance(
  harness: Harness,
  conversationId: ConversationId,
  ids: EntryId[] | SubmissionId[],
  pending = false,
) {
  if (!ids.length) return {}
  return harness.commit(async (tx) => {
    const wanted = new Set<number>(ids)
    const queued = pending ? ((await tx.doc(InboxDoc, conversationId))?.items ?? []) : []
    const pendingIds = new Set(queued.filter((item) => wanted.has(item.id)).map((item) => item.id))
    const visible = new Set<EntryId>()
    const owners = new Set<ConversationId>()
    let cursor: Cursor | undefined
    if (pending) owners.add(conversationId)
    else
      do {
        const page = await tx.scanEntries(
          {
            conversationId,
            minEntryId: Math.min(...ids) as EntryId,
            maxEntryId: Math.max(...ids) as EntryId,
          },
          500,
          cursor,
        )
        for (const entry of page.items)
          if (entry.kind === 'pi.user' && wanted.has(entry.id)) {
            visible.add(entry.id)
            owners.add(entry.conversationId)
          }
        cursor = page.next
      } while (cursor)
    const result: Record<string, AgentOrigin> = {}
    const identity = (submission: SubmissionRecord | undefined) =>
      pending
        ? submission?.conversationId === conversationId && pendingIds.has(submission.id)
          ? submission.id
          : undefined
        : submission?.entry && visible.has(submission.entry)
          ? submission.entry
          : undefined
    const sources = new Set(owners)
    for (const owner of owners) {
      const conversation = await tx.conversation(owner)
      if (conversation?.owner) sources.add(conversation.owner.conversationId)
    }
    for (const source of sources) {
      do {
        const page = await tx.scanTasks(
          { conversationId: source, kind: 'ultimate.subagent-reporter' },
          500,
          cursor,
        )
        for (const task of page.items) {
          const input = task.input as {
            conversationId: ConversationId
            sourceEntry?: EntryId
            answer?: EntryId
          }
          const delivery = await tx.submissionByRequest(input.conversationId, `subagent:${task.id}`)
          const instructionId = identity(delivery)
          if (instructionId) {
            result[instructionId] = {
              sender: task.conversationId,
              kind: 'instruction',
              ...(input.sourceEntry ? { entry: input.sourceEntry } : {}),
            }
          }
          const answer =
            input.answer ??
            (delivery?.type === 'input' && delivery.status === 'done' ? delivery.answer : undefined)
          for (const [request, entry] of [
            ...(answer ? [[`subagent-answer:${answer}`, answer] as const] : []),
            [`subagent-report:${task.id}`, delivery?.entry] as const,
          ]) {
            const report = await tx.submissionByRequest(task.conversationId, request)
            const reportId = identity(report)
            if (reportId) {
              result[reportId] = {
                sender: input.conversationId,
                kind: 'report',
                ...(entry ? { entry } : {}),
              }
            }
          }
        }
        cursor = page.next
      } while (cursor)
    }
    return result
  }, BACKGROUND_CONTEXT)
}
