import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, Cursor, EntryId, Harness } from '@earendil-works/pi-durable'
import type { AgentOrigin } from './message-types.ts'

/** Batch fork-aware history and scoped reporter scans, never scan history per row. */
export async function provenance(harness: Harness, conversationId: ConversationId, ids: EntryId[]) {
  if (!ids.length) return {}
  return harness.commit(async (tx) => {
    const wanted = new Set(ids)
    const visible = new Set<EntryId>()
    const owners = new Set<ConversationId>()
    let cursor: Cursor | undefined
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
          const input = task.input as { conversationId: ConversationId; sourceEntry?: EntryId }
          const delivery = await tx.submissionByRequest(input.conversationId, `subagent:${task.id}`)
          if (delivery?.entry && visible.has(delivery.entry)) {
            result[delivery.entry] = {
              sender: task.conversationId,
              kind: 'instruction',
              ...(input.sourceEntry ? { entry: input.sourceEntry } : {}),
            }
          }
          const answer =
            delivery?.type === 'input' && delivery.status === 'done' ? delivery.answer : undefined
          for (const [request, entry] of [
            ...(answer ? [[`subagent-answer:${answer}`, answer] as const] : []),
            [`subagent-report:${task.id}`, delivery?.entry] as const,
          ]) {
            const report = await tx.submissionByRequest(task.conversationId, request)
            if (report?.entry && visible.has(report.entry)) {
              result[report.entry] = {
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
