import { ArrowRightIcon } from 'lucide-react'
import { cn, events, useDocOf, useUltimate } from '@/sdk'
import { MessagesDoc } from '../messages/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import { Moon } from './moon.tsx'
import { journalDialog } from './pinned.tsx'
import { DreamDoc } from './refs.ts'
import { STAGES, stepOf } from './types.ts'
import type { DreamStep } from './types.ts'

const stageLabels: Record<DreamStep['stage'], string> = {
  handoff: 'Handoff',
  dreaming: 'Dreaming',
  deciding: 'Deciding',
  settled: 'Settled',
  asleep: 'Asleep',
}

const buttons: Record<NonNullable<DreamStep['action']>, string> = {
  decide: 'Decide with @ultimate',
  sleep: 'Fall asleep…',
  failed: 'See why',
}

/**
 * The sidebar's Dream section, on every surface while a dream needs following: from the handoff to the switch. The
 * five stages as moons, where it stands in one sentence, and the one thing the user has to do, a click away.
 */
export function DreamSection() {
  const doc = useDocOf(1, DreamDoc)
  const ultimate = useDocOf(1, StandingDoc)?.ultimate
  const messages = useDocOf(1, MessagesDoc)?.messages
  const actions = useUltimate()
  const step = stepOf(doc ?? undefined)
  if (!step) return null
  const current = STAGES.indexOf(step.stage)
  const act = async () => {
    if (step.action !== 'decide') return actions.open(journalDialog)
    // The newest question @ultimate asked that still waits: its card is where the proposals are decided.
    const asked = messages?.findLast(
      (message) =>
        message.from === ultimate &&
        message.to === 'user' &&
        message.reply &&
        message.state === 'delivered' &&
        !!message.questions?.length,
    )
    if (asked?.call && ultimate !== undefined)
      events.emit('messages:open', { conversation: ultimate, call: asked.call })
    await talkToUltimate(actions)
  }
  return (
    <section
      aria-label="Dream"
      className="mb-1 flex flex-col gap-1 border-b border-border/60 pb-2"
      data-sidebar-section="dream"
      data-dream-stage={step.stage}
    >
      <div className="mx-2 flex h-6 items-center gap-1.5 px-1 font-mono text-[9.5px] tracking-wider text-muted-foreground/70 uppercase">
        Dream
        {step.session !== undefined && (
          <span className="tracking-normal normal-case">· session {step.session}</span>
        )}
      </div>
      <div
        className={cn(
          'mx-2 rounded-md border border-l-2 border-border/70 bg-muted/30 px-2.5 py-2',
          step.action === 'failed' ? 'border-l-error/60' : 'border-l-brand/50',
        )}
      >
        <ol className="flex items-center gap-1" title={`Dream: ${stageLabels[step.stage]}`}>
          {STAGES.map((stage, index) => (
            <li className="flex items-center gap-1" data-stage={stage} key={stage}>
              {index > 0 && (
                <span
                  className={cn(
                    'h-px w-2.5',
                    index <= current ? 'bg-brand/50' : 'bg-muted-foreground/25',
                  )}
                />
              )}
              <Moon
                status={
                  index < current
                    ? 'done'
                    : index === current
                      ? step.action === 'failed'
                        ? 'failed'
                        : 'running'
                      : 'waiting'
                }
              />
            </li>
          ))}
          <li className="ml-1.5 truncate font-mono text-[10.5px] text-foreground/80">
            {stageLabels[step.stage]}
          </li>
        </ol>
        <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground" data-dream-step-text>
          {step.text}
        </p>
        {step.action ? (
          <button
            className={cn(
              'mt-1.5 flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
              step.action === 'failed'
                ? 'border-error/40 text-error hover:bg-error/10'
                : 'border-brand/50 text-foreground hover:border-brand hover:bg-brand/10',
            )}
            data-dream-step-action={step.action}
            onClick={() => void act()}
            type="button"
          >
            {buttons[step.action]}
            <ArrowRightIcon className="size-3" />
          </button>
        ) : (
          step.session !== undefined && (
            <button
              className="mt-1 cursor-pointer font-mono text-[10.5px] text-muted-foreground/80 hover:text-foreground"
              onClick={() => actions.open(journalDialog)}
              type="button"
            >
              Show the journal
            </button>
          )
        )}
      </div>
    </section>
  )
}
