import { cn } from 'cn'
import {
  ArrowUpRightIcon,
  CheckIcon,
  SquareArrowOutUpRightIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MentionText } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { api, Fold, useConversations, useUltimate } from '@/sdk'
import { FeatureTag } from '../conversations/ui.tsx'
import { GithubAction } from './refs.ts'
import type { ConversationSubject } from '../conversations/types.ts'

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

let repo: Promise<string | null> | undefined
/** The project's `github.com/<owner>/<repo>`, or null off GitHub; asked once per page. */
export function useGithubRepo() {
  const [url, setUrl] = useState<string | null>()
  useEffect(() => {
    repo ??= api.action(GithubAction).catch(
      // No repository: landings show their count without a link.
      () => null,
    )
    let live = true
    void repo.then((value) => live && setUrl(value))
    return () => {
      live = false
    }
  }, [])
  return url
}

/** "3 commits", linking to the landing's compare range on DiffsHub when there is one. */
export function CommitCount({
  count,
  href,
  className,
}: {
  count: number
  href?: string
  className?: string
}) {
  const label = `${count} commit${count === 1 ? '' : 's'}`
  if (!href) return <span className={cn('shrink-0', className)}>{label}</span>
  return (
    <a
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 hover:text-foreground hover:underline',
        className,
      )}
      href={href}
      rel="noreferrer"
      target="_blank"
      title={`Compare on GitHub: ${href.replace(/^https:\/\/github\.com\//, '')}`}
    >
      {label}
      <ArrowUpRightIcon className="size-2.5 opacity-60" />
    </a>
  )
}

/** The feature a submission lands, as one line: its feature tag and title, then `#id`. */
export function Subject({
  subject,
  from,
  className,
}: {
  subject?: ConversationSubject
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
  landed: ['border-l-success/70', 'text-success', CheckIcon, 'landed'],
  pushFailed: ['border-l-warning/70', 'text-warning', TriangleAlertIcon, 'push failed'],
  failed: ['border-l-error/70', 'text-error', XIcon, 'not landed'],
} as const

/**
 * A landing as one card: the feature it lands (tag, title, summary) from its conversation's summary at submit time,
 * the outcome's headline, then `children` (commits, flaky checks, steps). The lander's log, the submitter's report and
 * the root's note all show it. In a chat it folds to one line: the outcome, the feature, `sha`.
 */
export function LandingCard({
  card,
  tone,
  headline,
  subject,
  from,
  sha,
  at,
  divergence,
  sourceEntry,
  children,
}: {
  /** The entry that shows it, which keeps its fold state. */
  card: number
  tone: LandingTone
  headline: ReactNode
  subject?: ConversationSubject
  /** The submitting conversation. */
  from: number
  /** The landed commit, for the folded line. */
  sha?: string
  at?: ReactNode
  divergence?: string
  sourceEntry?: number
  children?: ReactNode
}) {
  const [border, color, Icon, label] = tones[tone]
  return (
    <Fold
      card={card}
      summary={
        <>
          <Icon className={cn('size-3 shrink-0', color)} />
          <span className={cn('shrink-0', color)}>{label}</span>
          {subject?.feature && <FeatureTag className="shrink-0" feature={subject.feature} />}
          <span className="min-w-0 truncate text-foreground/80">
            {subject?.title ?? `#${from}`}
          </span>
          {subject?.title && <span className="shrink-0">#{from}</span>}
          {sha && <span className="shrink-0">· {sha.slice(0, 7)}</span>}
        </>
      }
    >
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
              <span className="min-w-0 font-sans text-[12.5px] break-words">
                <MentionText text={divergence} />
              </span>
            </p>
          )}
          {children}
        </div>
      </section>
    </Fold>
  )
}
