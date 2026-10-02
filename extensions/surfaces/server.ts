import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'

/** Names the surface on screen, as the web host records it in `shell.shownSurface`, in each top-level conversation's prompt. */
export default (host: ExtensionHost) =>
  defineExtension({
    name: 'surfaces',
    sections: [
      section('surface', async (input, context) => {
        // Top-level conversations are neither owned (subagents) nor forked.
        const record = await host
          .harness()
          .commit((tx) => tx.conversation(input.conversationId), context)
        if (!record || record.owner || record.parent) return undefined
        const shown = (await host.uiState(context))['shell.shownSurface']
        const { id, title } =
          shown && typeof shown === 'object' && !Array.isArray(shown) ? shown : {}
        return typeof id === 'string' && typeof title === 'string'
          ? `The user is looking at the ${title} surface (${id}).`
          : 'The user is looking at the Agent surface (agent).'
      }),
    ],
  })
