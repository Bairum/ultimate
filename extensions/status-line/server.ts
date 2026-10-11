import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension, LiveDoc, UsageDoc } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'

export const actions = {
  async rates(_args: unknown, { host, conversationId }: ActionContext) {
    if (conversationId === undefined) throw new Error('Expected a shown conversation id')
    const summaries = host.conversations()
    const scope = [conversationId]
    const candidates: typeof summaries = []
    for (const parent of scope) {
      for (const child of summaries) {
        if (
          child.parentConversationId === parent &&
          child.ownerTaskId !== undefined &&
          !scope.includes(child.id)
        ) {
          scope.push(child.id)
          candidates.push(child)
        }
      }
    }
    // All document reads share the settlement commit boundary: never settled + the old partial.
    return host.harness().commit(async (tx) => {
      const root = await tx.conversation(conversationId as ConversationId)
      if (!root) throw new Error(`Unknown conversation ${conversationId}`)
      const validated = new Set([conversationId])
      for (const child of candidates) {
        const record = await tx.conversation(child.id as ConversationId)
        if (
          record?.owner &&
          validated.has(record.owner.conversationId) &&
          record.owner.conversationId === child.parentConversationId &&
          record.owner.taskId === child.ownerTaskId
        )
          validated.add(child.id)
      }
      const counters = []
      for (const id of validated) {
        const usage = await tx.doc(UsageDoc, id as ConversationId)
        const live = await tx.doc(LiveDoc, id as ConversationId)
        const total = { id, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        const partial = live.generation?.message?.usage
        for (const bucket of [...Object.values(usage.models), ...(partial ? [partial] : [])]) {
          total.input += bucket.input
          total.output += bucket.output
          total.cacheRead += bucket.cacheRead
          total.cacheWrite += bucket.cacheWrite
        }
        counters.push(total)
      }
      return counters
    }, context)
  },
}

export default defineExtension({ name: 'status-line' })
