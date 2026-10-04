import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import { configure } from '@earendil-works/pi-durable'
import type { Agent, ConversationOwnership, Tx } from '@earendil-works/pi-durable'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ExtensionHost } from '../../server/extensions.ts'
import { definitionAgent } from './agents.ts'
import type { AgentDefinition } from './agents.ts'

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
    excludeTools?: string[]
    excludeExtensions?: string[]
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  },
) {
  const { parentAgent: parent, definition, modelRuntime } = options
  const change = definitionAgent(definition, parent, modelRuntime, options)
  const child = await tx.createConversation({ ownership: options.owner })
  await configure(tx, child.id, {
    ...change,
    cwd: parent.cwd ?? null,
  })
  Object.assign(await tx.doc(options.metadata, child.id), {
    label: options.label,
    title: options.title,
  })
  return child
}
