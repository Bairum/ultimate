import { useEffect, useState } from 'react'
import { defineWebExtension, useDocOf, useUltimate } from '@/sdk'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { PhaseState } from './types.ts'
import { PhaseLabel, usePhase } from './chip.tsx'

function useAnchor(conversationId: number | undefined) {
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>()
  useEffect(() => {
    let form: HTMLFormElement | null | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      if (!form?.isConnected) return
      const rect = form.getBoundingClientRect()
      setAnchor({ left: rect.left, bottom: innerHeight - rect.top + 6 })
    }
    // The column resizes when a side region toggles, which moves the prompt without resizing it.
    const observer = new ResizeObserver(measure)
    const attach = () => {
      const container = document.querySelector('[data-composer-target="conversation"]')
      form = container?.querySelector('form')
      if (!container?.parentElement || !form) {
        setAnchor(undefined)
        retry = setTimeout(attach, 250)
        return
      }
      observer.observe(container.parentElement)
      observer.observe(form)
      measure()
    }
    attach()
    addEventListener('resize', measure)
    return () => {
      clearTimeout(retry)
      observer.disconnect()
      removeEventListener('resize', measure)
    }
  }, [conversationId])
  return anchor
}

function PhaseOverlay() {
  const { surface, conversationId } = useUltimate()
  const phase = usePhase(conversationId)
  const phases = useDocOf<PhaseState>(1, 'ultimate.conversation-phases')
  const anchor = useAnchor(conversationId)
  if (surface !== 'agent' || !phase || !anchor) return null
  const confidence = phases?.conversations[conversationId!]?.confidence ?? 0
  return (
    <div className="fixed z-30" style={anchor} data-phase-pill>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex h-7 items-center rounded-full border border-border/70 bg-card/90 px-2.5 font-mono text-[11px] text-muted-foreground shadow-sm backdrop-blur">
            <PhaseLabel phase={phase} />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {phase === 'waiting'
            ? 'Subagents are working'
            : `Phase from Jev · ${Math.round(confidence * 100)}% sure`}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
export default defineWebExtension({ slots: { overlay: PhaseOverlay } })
