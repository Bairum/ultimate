import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { configure } from '@earendil-works/pi-durable'
import type {
  Agent,
  ConversationId,
  ConversationOwnership,
  EntryId,
  Tx,
} from '@earendil-works/pi-durable'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ExtensionHost } from '../../server/extensions.ts'
import { definitionAgent } from './agents.ts'
import type { AgentDefinition } from './agents.ts'

/** A conversation configured from a definition (or as a copy of the parent's agent), new or forked at `fork.at`. */
export async function createChild(
  tx: Tx,
  options: {
    owner: ConversationOwnership
    definition?: AgentDefinition
    parentAgent: Agent
    modelRuntime: ModelRuntime
    metadata: ExtensionHost['metadata']
    label: string
    title: string
    fork?: { conversationId: ConversationId; at: EntryId }
    cwd?: string
    excludeTools?: string[]
    excludeExtensions?: string[]
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  },
) {
  const { parentAgent: parent, definition, modelRuntime } = options
  const change = definitionAgent(definition, parent, modelRuntime, options)
  const child = options.fork
    ? await tx.forkConversation(options.fork.conversationId, options.fork.at, {
        ownership: options.owner,
      })
    : await tx.createConversation({ ownership: options.owner })
  await configure(tx, child.id, {
    ...change,
    cwd: options.cwd ?? parent.cwd ?? null,
  })
  Object.assign(await tx.doc(options.metadata, child.id), {
    label: options.label,
    title: options.title,
  })
  return child
}
