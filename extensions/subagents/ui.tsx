/**
 * Subagents for other extensions' browser code: opening the message that started an agent, the standing agents and
 * talking to the primary one, and the agent definitions.
 */
import { api, events } from '@/sdk'
import type { UltimateActions } from '@/sdk'
import { StandingAction } from './refs.ts'

export { DefinitionAction, DefinitionsAction, StandingAction, StandingDoc } from './refs.ts'

/** Show the primary agent's standing conversation on the Agent surface: @ultimate starts branches and keeps tallies. */
export async function talkToUltimate(
  actions: Pick<UltimateActions, 'switchConversation' | 'showSurface'>,
) {
  const id = await api.action(StandingAction, { name: 'ultimate' })
  actions.switchConversation(id)
  actions.showSurface('agent')
}

/** Show `source`, where an agent's message came from, with a way back to `receiver`, where it arrived. */
export function openAgentSource(
  switchConversation: (id: number) => void,
  source: { conversation: number; entry?: number },
  receiver: { conversation: number; entry?: number },
) {
  events.emit('subagents:source', { target: source, back: receiver })
  switchConversation(source.conversation)
}
