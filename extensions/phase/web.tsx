import { defineWebExtension, provide, useDocOf, useUltimate } from '@/sdk'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConversationPhase } from '../conversations/ui.tsx'
import { PhasesDoc } from './refs.ts'
import { PhaseLabel, phaseText, usePhase } from './ui.tsx'

/** A working conversation's phase for the sidebar: its label, its word, and whether it only waits on subagents. */
function useConversationPhase(id: number | undefined) {
  const phase = usePhase(id)
  return (
    phase && {
      label: <PhaseLabel phase={phase} />,
      word: phaseText(phase).toLowerCase(),
      waiting: phase === 'waiting',
    }
  )
}

/** The shown conversation's phase, right-aligned on the line under its composer. */
function PhaseStatus() {
  const { conversationId } = useUltimate()
  const phase = usePhase(conversationId)
  const phases = useDocOf(1, PhasesDoc)
  if (!phase) return null
  const confidence = phases?.conversations[conversationId!]?.confidence ?? 0
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-auto shrink-0 text-brand" data-phase-pill>
          <PhaseLabel phase={phase} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]" side="top">
        {phase === 'waiting'
          ? 'Subagents are working'
          : `Phase from Jev · ${Math.round(confidence * 100)}% sure`}
      </TooltipContent>
    </Tooltip>
  )
}
export default defineWebExtension({
  slots: { 'composer.status': { component: PhaseStatus, order: 100 } },
  provides: [provide(ConversationPhase, useConversationPhase)],
})
