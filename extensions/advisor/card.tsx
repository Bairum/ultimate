import {
  CheckIcon,
  ScanEyeIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MentionText } from '@/components/ai/message'
import { cn, errorMessage, Fold, useUltimate } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import type { AdvisorNoteEntry, Severity, StoredNote } from './refs.ts'
import { feedback, openAdvisorPanel, SeverityDot, tones, useAdvisorState, worst } from './parts.tsx'

/** What the agent saw of the advice: nothing, a passive note, a steer into its run, or its answer sent back. */
export const deliveries: Record<
  AdvisorNoteEntry['delivered'],
  { word: string; title: string; loud: boolean }
> = {
  card: { word: 'shown to you only', title: 'A card: the agent never sees it', loud: false },
  note: {
    word: 'agent reads it next turn',
    title: 'A passive note the agent reads with its next request',
    loud: false,
  },
  steer: {
    word: 'steered the run',
    title: 'Interrupted the running agent as a steering message',
    loud: true,
  },
  continue: {
    word: 'sent the answer back',
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
  const top = worst(data.notes.map((n) => n.severity)) ?? 'nit'
  const delivery = deliveries[data.delivered]
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
            title={`${delivery.title}\n${data.model}`}
          >
            {delivery.loud && <span className="mr-1 text-brand">●</span>}
            {delivery.word}
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
          {data.notes.map((note) => (
            <NoteRow key={note.id} note={note} stored={state.notes.find((n) => n.id === note.id)} />
          ))}
        </ul>
      </section>
    </Fold>
  )
}

function NoteRow({
  note,
  stored,
}: {
  note: AdvisorNoteEntry['notes'][number]
  stored: StoredNote | undefined
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
        </div>
      </div>
      {stored ? (
        <NoteControls
          className={cn(
            'ml-15',
            !stored.feedback &&
              stored.status === 'open' &&
              'opacity-0 transition-opacity group-focus-within/note:opacity-100 group-hover/note:opacity-100 [@media(hover:none)]:opacity-100',
          )}
          note={stored}
        />
      ) : (
        <p className="mt-1 pl-16 font-mono text-[10.5px] text-muted-foreground/50">
          no longer tracked
        </p>
      )}
    </li>
  )
}

/** Thumbs, resolve and dismiss, or reopen; a failure shows under them. */
export function NoteControls({ note, className }: { note: StoredNote; className?: string }) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const act = (change: Parameters<typeof feedback>[1]) => {
    setBusy(true)
    setError(undefined)
    feedback(note.id, change)
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }
  const button =
    'flex h-5 cursor-pointer items-center gap-1 rounded-sm px-1 text-muted-foreground/70 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50'
  const open = note.status === 'open'
  return (
    <div
      className={cn(
        'mt-1.5 -ml-1 flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-[10.5px]',
        className,
      )}
    >
      <button
        aria-label="Helpful"
        aria-pressed={note.feedback === 'up'}
        className={cn(button, note.feedback === 'up' && 'text-foreground')}
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
        className={cn(button, note.feedback === 'down' && 'text-foreground')}
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
          <button
            className={button}
            disabled={busy}
            onClick={() => act({ status: 'resolved' })}
            title="Mark resolved: it was right and is handled"
            type="button"
          >
            <CheckIcon className="size-3" />
            resolve
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => act({ status: 'dismissed' })}
            title="Dismiss: not worth acting on"
            type="button"
          >
            <XIcon className="size-3" />
            dismiss
          </button>
        </>
      ) : (
        <>
          <span className="px-1 text-muted-foreground/70">{note.status}</span>
          <button
            className={button}
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
