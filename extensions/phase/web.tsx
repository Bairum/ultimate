import { defineWebExtension, useDocOf, useUltimate } from '@/sdk'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PhasesDoc } from './refs.ts'
import { PhaseLabel, usePhase } from './ui.tsx'

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
})
