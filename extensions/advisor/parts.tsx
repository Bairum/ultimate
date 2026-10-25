import { useEffect } from 'react'
import { api, cn, events, useConversation, useDocOf, useUltimate } from '@/sdk'
import { AdvisorState, FeedbackAction, NOTE_ENTRY } from './refs.ts'
import type {
  AdvisorNoteEntry,
  AdvisorStateDoc,
  Feedback,
  NoteStatus,
  Severity,
  StoredNote,
} from './refs.ts'

export const PANEL = 'advisor'

/**
 * How loud each severity is: a nit stays grey, a concern takes the warning tone, a blocker the error tone, only on its
 * dot, word and left edge, never as a filled background.
 */
export const tones: Record<Severity, { dot: string; text: string; border: string }> = {
  nit: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', border: 'border-l-border' },
  concern: { dot: 'bg-warning', text: 'text-warning', border: 'border-l-warning/60' },
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
export const openNotes = (state: AdvisorStateDoc) =>
  state.notes.filter((note) => note.status === 'open')

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
    pending = { conversation: note.conversation, entry: note.entry, review: reviewOf(note.id) }
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
      events.emit('ultimate:reveal-entry', { conversationId: id, entryId: entry }),
    )
    return () => cancelAnimationFrame(frame)
  }, [id, entries, loading])
  return null
}

/** Thumbs and status for one note; the result streams back through `AdvisorState`. */
export const feedback = (
  note: string,
  change: { feedback?: Feedback | null; status?: NoteStatus },
) => api.action(FeedbackAction, { note, ...change })
