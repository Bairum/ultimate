import { cn } from 'cn'
import { CheckIcon, SquareArrowOutUpRightIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useConversations, useUltimate } from '@/sdk'
import { FeatureTag } from '../conversations/feature.tsx'
import type { LandingSubject } from './types.ts'

/** "open #id", with a dot while that conversation works. */
export function Open({
  id,
  className,
  label,
  entry,
}: {
  id: number
  className?: string
  label?: string
  entry?: number
}) {
  const { switchConversation } = useUltimate()
  const busy = useConversations().find((conversation) => conversation.id === id)?.busy
  return (
    <Button
      className={cn(
        'h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground',
        className,
      )}
      onClick={() => switchConversation(id)}
      size="xs"
      title={`Show conversation #${id}`}
      variant="ghost"
    >
      {busy && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />}
      <SquareArrowOutUpRightIcon className="size-3" />
      open {label ? `${label} ` : ''}#{id}
      {entry !== undefined ? `/${entry}` : ''}
    </Button>
  )
}

/** The feature a submission lands, as one line: its feature tag and title, then `#id`. */
export function Subject({
  subject,
  from,
  className,
}: {
  subject?: LandingSubject
  from: number
  className?: string
}) {
  const { switchConversation } = useUltimate()
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {subject?.feature && <FeatureTag className="shrink-0" feature={subject.feature} />}
      <button
        className="min-w-0 cursor-pointer truncate font-sans text-[12.5px] text-foreground hover:underline"
        onClick={() => switchConversation(from)}
        title={`Open #${from}`}
        type="button"
      >
        {subject?.title ?? `#${from}`}
      </button>
      {subject?.title && <span className="shrink-0 text-muted-foreground/70">#{from}</span>}
    </span>
  )
}

export type LandingTone = 'landed' | 'pushFailed' | 'failed'
const tones = {
  landed: ['border-l-success/70', 'text-success', CheckIcon],
  pushFailed: ['border-l-warning/70', 'text-warning', TriangleAlertIcon],
  failed: ['border-l-error/70', 'text-error', XIcon],
} as const

/**
 * A landing as one card: the feature it lands (tag, title, summary) from its conversation's summary at submit time,
 * the outcome's headline, then `children` (commits, flaky checks, steps). The lander's log, the submitter's report and
 * the root's note all show it.
 */
export function LandingCard({
  tone,
  headline,
  subject,
  from,
  at,
  divergence,
  sourceEntry,
  children,
}: {
  tone: LandingTone
  headline: ReactNode
  subject?: LandingSubject
  /** The submitting conversation. */
  from: number
  at?: ReactNode
  divergence?: string
  sourceEntry?: number
  children?: ReactNode
}) {
  const [border, color, Icon] = tones[tone]
  return (
    <section
      className={cn(
        'min-w-0 rounded-md border border-l-2 border-border bg-muted/20 font-mono text-[12px]',
        border,
      )}
      data-landing={tone}
    >
      <header className="space-y-1 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn('size-3.5 shrink-0', color)} />
          <Subject className="flex-1" from={from} subject={subject} />
          {sourceEntry !== undefined && <Open id={from} entry={sourceEntry} />}
        </div>
        {subject?.summary && (
          <p className="pl-5.5 font-sans text-[12.5px] leading-relaxed text-muted-foreground">
            {subject.summary}
          </p>
        )}
      </header>
      <div className="space-y-1.5 px-3 py-2.5 pl-8.5">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 break-words text-foreground/90">{headline}</span>
          {at}
        </div>
        {divergence && (
          <p className="flex items-baseline gap-2 text-muted-foreground">
            <span className="shrink-0 text-[11px]">Diverged</span>
            <span className="min-w-0 font-sans text-[12.5px] break-words">{divergence}</span>
          </p>
        )}
        {children}
      </div>
    </section>
  )
}
