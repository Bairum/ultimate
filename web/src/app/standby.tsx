import { useEffect } from 'react'
import type { JsonObject } from '@earendil-works/pi-durable'
import { ConversationEmptyState } from '@/components/ai/conversation'
import { useSystem } from '../sdk/hooks.ts'
import { rendered } from '../sdk/resume.ts'
import { Slot } from './boundary.tsx'
import { projectTitle } from './titlebar.tsx'

/** The page while the server runs without storage: why, and the `standby` slot's controls, such as moving it here. */
export function Standby({ standby }: { standby: JsonObject }) {
  const system = useSystem()
  const project = projectTitle(system)
  // No conversation shows on standby, so this is what a reload resumes.
  useEffect(() => rendered(), [])
  return (
    <ConversationEmptyState className="h-dvh">
      <div className="w-full max-w-md">
        <div className="font-mono text-[13px] font-semibold tracking-[0.3em] text-brand">
          ULTIMATE
        </div>
        <h1 className="mt-4 text-[15px] font-medium text-foreground">This machine is on standby</h1>
        {typeof standby.reason === 'string' && (
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{standby.reason}</p>
        )}
        <div className="mt-5 border-t border-border/70 pt-4 font-mono text-[12px] text-muted-foreground/80">
          {[project, system?.machine.hostname].filter(Boolean).join(' · ')}
        </div>
        <div className="mt-4 flex flex-col items-center gap-2 empty:hidden">
          <Slot name="standby" />
        </div>
      </div>
    </ConversationEmptyState>
  )
}
