import { Checkbox } from '@/components/ui/checkbox'
import { cn, formatAgo, useNow } from '@/sdk'
import type { StoredNote } from './refs.ts'
import {
  feedback,
  isLive,
  outcomeOf,
  outcomes,
  SeverityDot,
  tones,
  useAdvisorState,
  useOpenNote,
} from './parts.tsx'

/**
 * @ultimate's concerns and blockers stay on the user's list until the user ticks them: open ones, and ones it deferred
 * (the close-out resolves those automatically, but the matter is still open). Its answers are the user's chat, so
 * nothing else would keep them from scrolling away (#101169).
 */
export const onList = (note: StoredNote, now: number) =>
  note.role === 'ultimate' &&
  note.severity !== 'nit' &&
  (isLive(note, now) ||
    (note.closedBy === 'auto' &&
      note.response?.status === 'deferred' &&
      note.archivedAt === undefined))

/** The `todos.for-you` rows: one per listed note, ticking it resolves the note for good. */
export function useForYou() {
  const state = useAdvisorState()
  const now = useNow(60_000)
  const notes = state.notes.filter((note) => onList(note, now)).toSorted((a, b) => b.at - a.at)
  if (!notes.length) return undefined
  return {
    count: notes.length,
    rows: notes.map((note) => <NoteRow key={note.id} note={note} now={now} />),
  }
}

/** A to-do row: tick to resolve, the advice, what @ultimate did with it so far, and its age; the text opens the card. */
function NoteRow({ note, now }: { note: StoredNote; now: number }) {
  const open = useOpenNote()
  const outcome = outcomeOf(note)
  const status = outcome ? outcomes[outcome] : undefined
  return (
    <li
      className="flex items-start gap-2.5 rounded py-1.5 pr-2 pl-2 hover:bg-muted/50"
      data-todo-advisor={note.id}
    >
      <Checkbox
        aria-label={`Resolve: ${note.note}`}
        checked={false}
        className="mt-0.5"
        // oxlint-disable-next-line typescript/no-floating-promises -- a failed action becomes a notice.
        onCheckedChange={() => void feedback(note.id, { status: 'resolved' })}
      />
      <button
        className="min-w-0 flex-1 cursor-pointer text-left"
        onClick={() => open(note)}
        title="Show the advisor note in @ultimate's conversation"
        type="button"
      >
        {/* Plain text: mention links would nest a control inside this button. */}
        <span className="line-clamp-2 text-[13px] leading-snug">
          {note.note.replaceAll('`', '')}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
          <SeverityDot severity={note.severity} />
          <span className={tones[note.severity].text}>{note.severity}</span>
          <span className="text-muted-foreground/60">· advisor</span>
          <span
            className={cn('truncate', status?.text ?? 'text-muted-foreground/70')}
            title={[status?.title, note.response?.reason].filter(Boolean).join('\n')}
          >
            · {status?.word ?? 'not seen yet'}
          </span>
        </span>
      </button>
      <time
        className="shrink-0 pt-px font-mono text-[11px] text-muted-foreground/70"
        dateTime={new Date(note.at).toISOString()}
        title={new Date(note.at).toLocaleString()}
      >
        {formatAgo(note.at, now)}
      </time>
    </li>
  )
}
