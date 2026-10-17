import { useConversations, useDocOf, useExtensions } from '@/sdk'
import type { Phase, PhaseState } from './types.ts'
import { subagentsBusy } from '../conversations/subtree.tsx'

export type DisplayPhase = Phase | 'waiting'
export function usePhase(conversationId: number | undefined): DisplayPhase | undefined {
  const conversations = useConversations()
  const phases = useDocOf<PhaseState>(1, 'ultimate.conversation-phases')
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
export function PhaseLabel({ phase }: { phase: DisplayPhase }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
      {labels[phase]}
    </span>
  )
}
