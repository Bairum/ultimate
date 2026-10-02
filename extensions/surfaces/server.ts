import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

/** Names the surface on screen, as the web host records it in `shell.shownSurface`, in each top-level conversation's prompt. */
export default (host: ExtensionHost) => {
  /** Whether each conversation is top-level, read once: `owner` and `parent` never change after creation. */
  const topLevel = new Map<ConversationId, boolean>()
  return defineExtension({
    name: 'surfaces',
    sections: [
      section('surface', async (input, context) => {
        // Top-level conversations are neither owned (subagents) nor forked.
        if (!topLevel.has(input.conversationId)) {
          const record = await host
            .harness()
            .commit((tx) => tx.conversation(input.conversationId), context)
          if (!record) return undefined
          topLevel.set(input.conversationId, !record.owner && !record.parent)
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
