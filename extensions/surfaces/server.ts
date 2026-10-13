import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

/** Names the surface on screen, as the web host records it in `shell.shownSurface`, in each top-level conversation's prompt. */
export default (host: ExtensionHost) => {
  /** Whether each conversation is top-level, read once: `owner` never changes after creation. */
  const topLevel = new Map<ConversationId, boolean>()
  return defineExtension({
    name: 'surfaces',
    sections: [
      section('surface', async (input, context) => {
        // Top-level conversations have no owner.
        if (!topLevel.has(input.conversationId)) {
          const record = await host
            .harness()
            .commit((tx) => tx.conversation(input.conversationId), context)
          if (!record) return undefined
          topLevel.set(input.conversationId, !record.owner)
        }
        if (!topLevel.get(input.conversationId)) return undefined
        const shown = (await host.uiState(context))['shell.shownSurface']
        const { id, title } =
          shown && typeof shown === 'object' && !Array.isArray(shown) ? shown : {}
        return typeof id === 'string' && typeof title === 'string'
          ? `The user is looking at the ${title} surface (${id}).`
          : 'The user is looking at the Agent surface (agent).'
      }),
    ],
  })
}
