import {
  AlarmClockIcon,
  CheckIcon,
  ChevronDownIcon,
  ScanEyeIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MentionText } from '@/components/ai/message'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, errorMessage, Fold, formatTime, useNow, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { DISMISS_REASONS } from './refs.ts'
import type { AdvisorNoteEntry, DismissReason, Severity, StoredNote } from './refs.ts'
import {
  closedPhrase,
  feedback,
  openAdvisorPanel,
  outcomeOf,
  outcomes,
  reasons,
  SeverityDot,
  SNOOZES,
  sources,
  tones,
  until,
  useAdvisorState,
  worst,
} from './parts.tsx'

/** What the agent saw of the advice: nothing, a passive note, a steer into its run, or its answer sent back. */
export const deliveries: Record<
  AdvisorNoteEntry['delivered'],
  { word: string; read: string; title: string; loud: boolean }
> = {
  card: {
    word: 'shown to you only',
    read: 'shown to you only',
    title: 'A card: the agent never sees it',
    loud: false,
  },
  note: {
    word: 'agent reads it next turn',
    read: 'agent read it',
    title: 'A passive note the agent reads with its next request',
    loud: false,
  },
  steer: {
    word: 'steered the run',
    read: 'steered the run',
    title: 'Interrupted the running agent as a steering message',
    loud: true,
  },
  continue: {
    word: 'sent the answer back',
    read: 'sent the answer back',
    title: 'Held the final answer and made the agent continue once',
    loud: true,
  },
}

const points: Record<AdvisorNoteEntry['point'], string> = {
  answer: 'on answer',
  rounds: 'mid-run',
  signals: 'on signal',
  idle: 'on idle',
}

/** Advice text: `code` spans as code, `#id` mentions as conversation links, the rest verbatim. */
export function AdviceText({ text }: { text: string }) {
  return text.split(/(`[^`\n]+`)/).map((part, index) =>
    /^`[^`\n]+`$/.test(part) ? (
      <code className="rounded-sm bg-muted px-1 py-px font-mono text-[0.92em]" key={index}>
        {part.slice(1, -1)}
      </code>
    ) : (
      <MentionText key={index} text={part} />
    ),
  )
}

/** One review's notes in the reviewed conversation's transcript. */
export function AdvisorNoteCard({ entry }: { entry: EntryRecord }) {
  const data = entry.data as AdvisorNoteEntry
  const shell = useUltimate()
  const state = useAdvisorState()
  const now = useNow(60_000)
  const top = worst(data.notes.map((n) => n.severity)) ?? 'nit'
  const delivery = deliveries[data.delivered]
  const stored = data.notes.map((note) => state.notes.find((n) => n.id === note.id))
  // One delivery carries every note of the review, so the first request that read any of them read them all.
  const readAt = stored
    .map((n) => n?.readAt)
    .filter((at) => at !== undefined)
    .toSorted((a, b) => a - b)[0]
  const deliveredAt = stored.find((n) => n !== undefined)?.at
  const counts = (['blocker', 'concern', 'nit'] as Severity[])
    .map((s) => [s, data.notes.filter((n) => n.severity === s).length] as const)
    .filter(([, n]) => n > 0)
  const label: ReactNode = (
    <>
      <span className="shrink-0 text-foreground">{data.advisor}</span>
      <span className="shrink-0">advisor</span>
      {counts.map(([s, n]) => (
        <span className={cn('flex shrink-0 items-center gap-1', tones[s].text)} key={s}>
          <SeverityDot severity={s} />
          {n > 1 ? `${n} ${s}s` : s}
        </span>
      ))}
    </>
  )
  const timeline = [
    delivery.title,
    deliveredAt !== undefined && `Delivered ${new Date(deliveredAt).toLocaleString()}`,
    readAt !== undefined && `Read by a model request ${new Date(readAt).toLocaleString()}`,
    data.model,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <Fold
      card={entry.id}
      keep={top === 'blocker'}
      summary={
        <>
          <ScanEyeIcon className="size-3 shrink-0" />
          {label}
        </>
      }
    >
      <section
        className={cn(
          'min-w-0 rounded-md border border-l-2 border-border bg-muted/20',
          tones[top].border,
        )}
        data-advisor-note={top}
        data-delivered={data.delivered}
      >
        <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <ScanEyeIcon className="size-3.5 shrink-0" />
          {label}
          <span className="shrink-0 text-muted-foreground/70">
            {data.role} · {points[data.point]}
          </span>
          <span
            className={cn('ml-auto shrink-0', delivery.loud && 'text-foreground/85')}
            data-read={readAt !== undefined || undefined}
            title={timeline}
          >
            {delivery.loud && <span className="mr-1 text-brand">●</span>}
            {readAt !== undefined ? delivery.read : delivery.word}
            {readAt !== undefined && (
              <span className="text-muted-foreground/60"> {formatTime(readAt)}</span>
            )}
          </span>
          <button
            className="shrink-0 cursor-pointer text-muted-foreground/70 hover:text-foreground hover:underline max-sm:hidden"
            onClick={() => openAdvisorPanel(shell)}
            title="Open the Advisor panel"
            type="button"
          >
            all advice
          </button>
        </header>
        <ul className="divide-y divide-border/50">
          {data.notes.map((note, index) => (
            <NoteRow key={note.id} note={note} now={now} stored={stored[index]} />
          ))}
        </ul>
      </section>
    </Fold>
  )
}

function NoteRow({
  note,
  stored,
  now,
}: {
  note: AdvisorNoteEntry['notes'][number]
  stored: StoredNote | undefined
  now: number
}) {
  const closed = stored && stored.status !== 'open'
  return (
    <li className="group/note px-3 py-2.5" data-note={note.id}>
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            'mt-[3px] w-14 shrink-0 font-mono text-[11px]',
            closed ? 'text-muted-foreground/60' : tones[note.severity].text,
          )}
        >
          {note.severity}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p
            className={cn(
              'text-[13px] leading-relaxed break-words whitespace-pre-wrap',
              closed && 'text-muted-foreground line-through decoration-muted-foreground/40',
            )}
          >
            <AdviceText text={note.note} />
          </p>
          <p className="font-mono text-[11px] leading-snug break-words text-muted-foreground/80">
            <span className="text-muted-foreground/50">evidence </span>
            <AdviceText text={note.evidence} />
          </p>
          {stored && <Response note={stored} />}
        </div>
      </div>
      {stored ? (
        <NoteControls
          className={cn(
            'ml-15',
            !stored.feedback &&
              stored.status === 'open' &&
              !(stored.snoozedUntil !== undefined && stored.snoozedUntil > now) &&
              'opacity-0 transition-opacity group-focus-within/note:opacity-100 group-hover/note:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100',
          )}
          note={stored}
          now={now}
        />
      ) : (
        <p className="mt-1 pl-16 font-mono text-[10.5px] text-muted-foreground/50">
          no longer tracked
        </p>
      )}
    </li>
  )
}

const silent: Partial<Record<string, string>> = {
  ignored: 'read, no response by the end of the run',
  unread: 'never reached the model',
  late: 'arrived after the agent had finished',
  pending: 'delivered, no response yet',
}

/**
 * What the agent did with a note: its word in tone, who says so, and the reason with its evidence. Cards and notes
 * from before lifecycle tracking have nothing to show.
 */
export function Response({ note }: { note: StoredNote }) {
  const outcome = outcomeOf(note)
  if (!outcome) return null
  const look = outcomes[outcome]
  const response = note.response
  const reason = response?.reason ?? silent[outcome]
  return (
    <div className="font-mono text-[11px] leading-snug break-words" data-response={outcome}>
      <p>
        <span className="text-muted-foreground/50">agent </span>
        <span className={look.text} title={look.title}>
          {look.word}
        </span>
        {response && response.source !== 'auto' && (
          <span
            className="text-muted-foreground/50"
            title={
              response.source === 'ack'
                ? `The agent's acknowledgement${note.ref ? ` of advisor ${note.ref}` : ''}`
                : 'A judge read the entries after delivery'
            }
          >
            {' '}
            · {sources[response.source]}
          </span>
        )}
        {reason && !response?.reason && (
          <span className="text-muted-foreground/60"> · {reason}</span>
        )}
      </p>
      {response?.reason && (
        <p className="mt-0.5 border-l border-border pl-2 font-sans text-[12px] leading-snug text-foreground/80">
          <AdviceText text={response.reason} />
        </p>
      )}
      {response?.evidence && (
        <p className="mt-0.5 pl-2 text-muted-foreground/70">
          <span className="text-muted-foreground/50">shown by </span>
          <AdviceText text={response.evidence} />
        </p>
      )}
    </div>
  )
}

/**
 * Thumbs, then resolve, dismiss with an optional reason and snooze while open; once closed, who closed it and why with
 * reopen; while snoozed, until when with wake. A failure shows under them.
 */
export function NoteControls({
  note,
  now,
  className,
}: {
  note: StoredNote
  now: number
  className?: string
}) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const act = (change: Parameters<typeof feedback>[1]) => {
    setBusy(true)
    setError(undefined)
    feedback(note.id, change)
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }
  const open = note.status === 'open'
  const snoozed = open && note.snoozedUntil !== undefined && note.snoozedUntil > now
  return (
    <div
      className={cn(
        'mt-1.5 -ml-1 flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-[10.5px]',
        className,
      )}
      data-note-state={snoozed ? 'snoozed' : note.status}
    >
      <button
        aria-label="Helpful"
        aria-pressed={note.feedback === 'up'}
        className={cn(control, note.feedback === 'up' && 'text-foreground')}
        disabled={busy}
        onClick={() => act({ feedback: note.feedback === 'up' ? null : 'up' })}
        title="Helpful advice"
        type="button"
      >
        <ThumbsUpIcon className={cn('size-3', note.feedback === 'up' && 'fill-current')} />
      </button>
      <button
        aria-label="Not helpful"
        aria-pressed={note.feedback === 'down'}
        className={cn(control, note.feedback === 'down' && 'text-foreground')}
        disabled={busy}
        onClick={() => act({ feedback: note.feedback === 'down' ? null : 'down' })}
        title="Not helpful"
        type="button"
      >
        <ThumbsDownIcon className={cn('size-3', note.feedback === 'down' && 'fill-current')} />
      </button>
      <span className="mx-1 h-3 w-px bg-border/70" />
      {open ? (
        <>
          {snoozed && (
            <>
              <span
                className="flex items-center gap-1 px-1 text-foreground/75"
                title={new Date(note.snoozedUntil!).toLocaleString()}
              >
                <AlarmClockIcon className="size-3" />
                until {until(note.snoozedUntil!, now)}
              </span>
              <button
                className={control}
                disabled={busy}
                onClick={() => act({ snoozeUntil: null })}
                title="Wake it now"
                type="button"
              >
                wake
              </button>
              <span className="mx-1 h-3 w-px bg-border/70" />
            </>
          )}
          <button
            className={control}
            disabled={busy}
            onClick={() => act({ status: 'resolved' })}
            title="Mark resolved: it was right and is handled"
            type="button"
          >
            <CheckIcon className="size-3" />
            resolve
          </button>
          <DismissMenu
            disabled={busy}
            onDismiss={(reason) => act({ status: 'dismissed', ...(reason ? { reason } : {}) })}
          />
          {!snoozed && (
            <SnoozeMenu disabled={busy} onSnooze={(ms) => act({ snoozeUntil: Date.now() + ms })} />
          )}
        </>
      ) : (
        <>
          <span className="px-1 text-muted-foreground/80" data-closed-by={note.closedBy}>
            {closedPhrase(note, now)}
          </span>
          <button
            className={control}
            disabled={busy}
            onClick={() => act({ status: 'open' })}
            title="Reopen"
            type="button"
          >
            <Undo2Icon className="size-3" />
            reopen
          </button>
        </>
      )}
      {error && <span className="basis-full pt-0.5 text-error">{error}</span>}
    </div>
  )
}

export const control =
  'flex h-5 cursor-pointer items-center gap-1 rounded-sm px-1 text-muted-foreground/70 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground'
export const menuItem = 'cursor-pointer py-1 font-mono text-[11.5px]'

/** Dismiss, optionally saying why: the reason feeds the audits as a user dismissal. */
export function DismissMenu({
  onDismiss,
  disabled,
  label = 'dismiss',
}: {
  onDismiss: (reason?: DismissReason) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={control}
        disabled={disabled}
        title="Dismiss: not worth acting on"
      >
        <XIcon className="size-3" />
        {label}
        <ChevronDownIcon className="size-2.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuLabel className="py-1 font-mono text-[10.5px] font-normal text-muted-foreground">
          dismiss as
        </DropdownMenuLabel>
        {DISMISS_REASONS.map((reason) => (
          <DropdownMenuItem className={menuItem} key={reason} onSelect={() => onDismiss(reason)}>
            {reasons[reason]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          className={cn(menuItem, 'text-muted-foreground')}
          onSelect={() => onDismiss()}
        >
          no reason
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SnoozeMenu({
  onSnooze,
  disabled,
}: {
  onSnooze: (ms: number) => void
  disabled?: boolean
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={control}
        disabled={disabled}
        title="Snooze: hide it from open notes and the status chip for a while"
      >
        <AlarmClockIcon className="size-3" />
        snooze
        <ChevronDownIcon className="size-2.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-32">
        {SNOOZES.map((snooze) => (
          <DropdownMenuItem
            className={menuItem}
            key={snooze.label}
            onSelect={() => onSnooze(snooze.ms)}
          >
            {snooze.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
