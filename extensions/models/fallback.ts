/**
 * A conversation whose model lost its login here switches, as its next run's input is placed, to its definition's pin
 * or the default model, and says so with one `models.fallback` entry.
 */
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { AgentDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { defaultModel, discoverAgents, hasLogin } from '../../lib/agents.ts'
import { Profile } from '../subagents/api.ts'
import type { Fallback } from './refs.ts'

const name = (ref: { provider: string; modelId: string }) => `${ref.provider}/${ref.modelId}`

export async function fallback(
  host: ExtensionHost,
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ entries: EntryDraft[] } | undefined> {
  const agent = await tx.doc(AgentDoc, conversationId)
  const available = host.modelRuntime.getAvailableSnapshot()
  // Nothing has a login yet (an empty snapshot says nothing about this model), or this one still has one.
  if (!agent.model || !available.length || hasLogin(available, agent.model)) return undefined
  // The definition it runs as: children and standing agents record it, branches and the lander carry it as a label.
  const definitionName =
    (await tx.doc(Profile, conversationId)).definition ??
    (await tx.doc(host.metadata, conversationId)).label
  const pin = definitionName
    ? (
        await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime)
      ).definitions.find((definition) => definition.name === definitionName)?.model
    : undefined
  const usable = hasLogin(available, pin) ? pin : undefined
  const to = usable ?? defaultModel(available, host.settings)
  if (!to) return undefined
  const from = name(agent.model)
  agent.model = { provider: to.provider, modelId: to.modelId }
  const model = host.modelRuntime.getModel(to.provider, to.modelId)
  if (model && agent.thinkingLevel)
    agent.thinkingLevel = clampThinkingLevel(model, agent.thinkingLevel)
  const data: Fallback = { from, to: name(to), reason: usable ? 'pin' : 'default' }
  return {
    entries: [
      {
        kind: 'models.fallback',
        data,
        model: [
          {
            role: 'user',
            content: `Model ${from} has no login here; this conversation now runs on ${data.to}.`,
            timestamp: Date.now(),
          },
        ],
      },
    ],
  }
}
