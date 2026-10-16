import { useConversations, useDocOf } from '@/sdk'
import type { Phase, PhaseState } from './types.ts'

export type DisplayPhase = Phase | 'waiting'
export function usePhase(conversationId: number | undefined): DisplayPhase | undefined {
  const conversations = useConversations()
  const phases = useDocOf<PhaseState>(1, 'ultimate.conversation-phases')
  if (conversationId === undefined) return undefined
  if (conversations.find((conversation) => conversation.id === conversationId)?.busy)
    return phases?.conversations[conversationId]?.phase
  const descendants = new Set([conversationId])
  let changed = true
  while (changed) {
    changed = false
    for (const conversation of conversations) {
      if (
        conversation.ownerTaskId !== undefined &&
        conversation.parentConversationId !== undefined &&
        descendants.has(conversation.parentConversationId) &&
        !descendants.has(conversation.id)
      ) {
        descendants.add(conversation.id)
        changed = true
      }
    }
  }
  return conversations.some(
    (conversation) =>
      conversation.id !== conversationId && descendants.has(conversation.id) && conversation.busy,
  )
    ? 'waiting'
    : undefined
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
