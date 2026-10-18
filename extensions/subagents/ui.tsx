/**
 * Subagents for other extensions' browser code: opening the message that started an agent, the standing agents, and
 * the agent definitions.
 */
import { events } from '@/sdk'

export { DefinitionsAction, StandingAction, StandingDoc } from './refs.ts'

/** Show `source`, where an agent's message came from, with a way back to `receiver`, where it arrived. */
export function openAgentSource(
  switchConversation: (id: number) => void,
  source: { conversation: number; entry?: number },
  receiver: { conversation: number; entry?: number },
) {
  events.emit('subagents:source', { target: source, back: receiver })
  switchConversation(source.conversation)
}
