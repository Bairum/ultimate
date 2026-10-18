/** Phase's components for other extensions: a conversation's live phase and its label. */
import { useConversations, useDocOf, useExtensions } from '@/sdk'
import { PhasesDoc } from './refs.ts'
import { subagentsBusy } from './subtree.tsx'
import type { Phase } from './types.ts'

export type DisplayPhase = Phase | 'waiting'
export function usePhase(conversationId: number | undefined): DisplayPhase | undefined {
  const conversations = useConversations()
  const phases = useDocOf(1, PhasesDoc)
  const enabled = useExtensions().some(
    (extension) => extension.name === 'phase' && extension.extension,
  )
  if (!enabled || conversationId === undefined) return undefined
  if (conversations.find((conversation) => conversation.id === conversationId)?.busy)
    return phases?.conversations[conversationId]?.phase
  return subagentsBusy(conversations, conversationId) ? 'waiting' : undefined
}
const labels: Record<DisplayPhase, string> = {
  exploring: 'Exploring',
  planning: 'Planning',
  editing: 'Editing',
  verifying: 'Verifying',
  fixing: 'Fixing',
  delegating: 'Delegating',
  waiting: 'Waiting',
  wrapping_up: 'Wrapping up',
}
export const phaseText = (phase: DisplayPhase) => labels[phase]
export function PhaseLabel({ phase }: { phase: DisplayPhase }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
      {labels[phase]}
    </span>
  )
}
