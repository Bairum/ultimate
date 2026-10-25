import { useEffect } from 'react'
import { api, cn, events, formatAgo, useConversation, useDocOf, useUltimate } from '@/sdk'
import { AdvisorState, FeedbackAction, ManageAction, NOTE_ENTRY } from './refs.ts'
import type {
  AdvisorNoteEntry,
  AdvisorStateDoc,
  DismissReason,
  Feedback,
  NoteSelection,
  NoteStatus,
  ResponseStatus,
  Severity,
  StoredNote,
} from './refs.ts'

export const PANEL = 'advisor'

/**
 * How loud each severity is: a nit stays grey, a concern takes the warning tone, a blocker the error tone, only on its
 * dot, word and left edge, never as a filled background.
 */
export const tones: Record<Severity, { dot: string; text: string; border: string }> = {
  nit: {
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    border: 'border-l-border',
  },
  concern: {
    dot: 'bg-warning',
    text: 'text-warning',
    border: 'border-l-warning/60',
  },
  blocker: { dot: 'bg-error', text: 'text-error', border: 'border-l-error/70' },
}
export const rank = (severity: Severity) => ['nit', 'concern', 'blocker'].indexOf(severity)
export const worst = (severities: Severity[]) =>
  severities.reduce<Severity | undefined>(
    (top, s) => (top === undefined || rank(s) > rank(top) ? s : top),
    undefined,
  )

export function SeverityDot({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', tones[severity].dot, className)}
    />
  )
}

/** `$0.04`, `$1.20`, `<$0.01` for a cost that is not zero. */
export function usd(value: number) {
  if (value === 0) return '$0'
  if (value < 0.01) return '<$0.01'
  return `$${value.toFixed(2)}`
}

const empty: AdvisorStateDoc = { conversations: {}, notes: [], spend: {} }
/** The root's advisor state, empty until it streams. */
export function useAdvisorState() {
  return useDocOf(1, AdvisorState) ?? empty
}
/** Open, not archived and not snoozed: what the chip counts and the panel's default view shows. */
export const isLive = (note: StoredNote, now: number) =>
  note.status === 'open' &&
  note.archivedAt === undefined &&
  !(note.snoozedUntil !== undefined && note.snoozedUntil > now)
export const openNotes = (state: AdvisorStateDoc, now: number) =>
  state.notes.filter((note) => isLive(note, now))

/** A note's response so far; `pending` while delivered to the agent without one. Cards and old notes have none. */
export type Outcome = ResponseStatus | 'pending'
export function outcomeOf(note: StoredNote): Outcome | undefined {
  if (note.delivered === 'card') return undefined
  if (note.response) return note.response.status
  // Closed without a response, nothing is still waiting.
  return note.ref === undefined || note.status !== 'open' ? undefined : 'pending'
}

/**
 * How each outcome reads: what the agent did gets a tone (addressed green, disputed in the brand colour), what it
 * didn't stays grey. Severity owns warning and error, so responses never use them.
 */
export const outcomes: Record<Outcome, { word: string; title: string; text: string; bar: string }> =
  {
    addressed: {
      word: 'addressed',
      title: 'The agent acted on it',
      text: 'text-success',
      bar: 'bg-success',
    },
    deferred: {
      word: 'deferred',
      title: 'The agent put it off, with a reason',
      text: 'text-foreground/80',
      bar: 'bg-foreground/45',
    },
    disputed: {
      word: 'disputed',
      title: 'The agent disagreed, with a reason',
      text: 'text-brand',
      bar: 'bg-brand',
    },
    ignored: {
      word: 'ignored',
      title: 'Read, but no response by the end of the run',
      text: 'text-muted-foreground',
      bar: 'bg-muted-foreground/50',
    },
    unread: {
      word: 'unread',
      title: 'Never reached a model request before the conversation finished',
      text: 'text-muted-foreground/70',
      bar: 'bg-muted-foreground/25',
    },
    late: {
      word: 'late',
      title: "Arrived after the agent's last run had ended",
      text: 'text-muted-foreground/70',
      bar: 'bg-muted-foreground/25',
    },
    pending: {
      word: 'waiting',
      title: 'Delivered; the agent has not responded yet',
      text: 'text-muted-foreground/70',
      bar: 'bg-transparent',
    },
  }
export const OUTCOMES = Object.keys(outcomes) as Outcome[]

export const sources: Record<NonNullable<StoredNote['response']>['source'], string> = {
  ack: 'acknowledged',
  judged: 'judged',
  auto: 'auto',
}

/** Who judged a response, and how sure Jev was: "Jev 92%", or "Sol · Jev 40%" when Jev was unsure. */
export function judgeLabel(response: StoredNote['response']) {
  if (response?.source !== 'judged' || !response.judge) return undefined
  const jev =
    response.confidence === undefined ? '' : `Jev ${Math.round(response.confidence * 100)}%`
  return response.judge === 'jev' ? jev || 'Jev' : ['Sol', jev].filter(Boolean).join(' · ')
}

export const reasons: Record<DismissReason, string> = {
  'false-alarm': 'false alarm',
  handled: 'already handled',
  'wont-fix': "won't fix",
}

/** "dismissed by you · false alarm · 2h ago", "resolved automatically", "snoozed until Mon 09:00". */
export function closedPhrase(note: StoredNote, now: number) {
  if (note.status === 'open')
    return note.snoozedUntil !== undefined && note.snoozedUntil > now
      ? `snoozed until ${until(note.snoozedUntil, now)}`
      : undefined
  return [
    `${note.status}${note.closedBy === 'user' ? ' by you' : note.closedBy === 'auto' ? ' automatically' : ''}`,
    note.dismissReason && reasons[note.dismissReason],
    note.closedAt !== undefined && formatAgo(note.closedAt, now, { ago: true }),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** A future time: `15:40` today, `Tue 09:00` this week, else a date. */
export function until(at: number, now: number) {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  if (date.toDateString() === new Date(now).toDateString()) return time
  if (at - now < 6 * 86_400_000)
    return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export const SNOOZES = [
  { label: '1 hour', ms: 3_600_000 },
  { label: '1 day', ms: 86_400_000 },
  { label: '1 week', ms: 7 * 86_400_000 },
] as const

export function openAdvisorPanel(shell: {
  showSurface: (id: string) => void
  openPanel: (id?: string) => void
}) {
  shell.showSurface('agent')
  shell.openPanel(PANEL)
}

/** A note's review: its id is `<review>:<index>`. */
export const reviewOf = (note: string) => note.slice(0, note.lastIndexOf(':'))

let pending: { conversation: number; entry?: number; review: string } | undefined
/**
 * Shows a note's conversation and scrolls to its card: the stored entry when known, else the loaded `advisor.note`
 * entry of its review.
 */
export function useOpenNote() {
  const { switchConversation, showSurface } = useUltimate()
  return (note: Pick<StoredNote, 'id' | 'conversation' | 'entry'>) => {
    pending = {
      conversation: note.conversation,
      entry: note.entry,
      review: reviewOf(note.id),
    }
    showSurface('agent')
    switchConversation(note.conversation)
  }
}
/** Reveals a pending note's card once its conversation has loaded; mounted in the overlay so it outlives the switch. */
export function NoteNavigation() {
  const { id, entries, loading } = useConversation()
  useEffect(() => {
    const target = pending
    if (!target || target.conversation !== id || loading) return undefined
    pending = undefined
    const entry =
      target.entry ??
      entries.find(
        (e) => e.kind === NOTE_ENTRY && (e.data as AdvisorNoteEntry).review === target.review,
      )?.id
    if (entry === undefined) return undefined
    const frame = requestAnimationFrame(() =>
      events.emit('ultimate:reveal-entry', {
        conversationId: id,
        entryId: entry,
      }),
    )
    return () => cancelAnimationFrame(frame)
  }, [id, entries, loading])
  return null
}

/** Thumbs, status, dismissal reason or snooze for one note; the result streams back through `AdvisorState`. */
export const feedback = (
  note: string,
  change: {
    feedback?: Feedback | null
    status?: NoteStatus
    reason?: DismissReason
    snoozeUntil?: number | null
  },
) => api.action(FeedbackAction, { note, ...change })

/** Bulk resolve, dismiss, reopen or archive; resolves to how many notes changed. */
export const manage = (
  args: NoteSelection & {
    do: 'resolve' | 'dismiss' | 'reopen' | 'archive'
    reason?: DismissReason
  },
) => api.action(ManageAction, args)
