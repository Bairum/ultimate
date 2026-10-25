import type {
  DismissReason,
  NoteStatus,
  StoredNote,
  AdvisorStateDoc,
  NoteSelection,
} from './refs.ts'
import { DISMISS_REASONS, ROLES } from './refs.ts'

export function validReason(reason: unknown): reason is DismissReason | undefined {
  return reason === undefined || DISMISS_REASONS.includes(reason as DismissReason)
}
export function setStatus(
  note: StoredNote,
  status: NoteStatus,
  now: number,
  reason?: DismissReason,
) {
  note.status = status
  if (status === 'open') {
    delete note.closedBy
    delete note.closedAt
    delete note.dismissReason
    delete note.archivedAt
  } else {
    note.closedBy = 'user'
    note.closedAt = now
    if (status === 'dismissed' && reason) note.dismissReason = reason
    else delete note.dismissReason
  }
}
export function autoResolve(note: StoredNote, now: number) {
  if (note.closedBy === 'user' || note.status !== 'open') return
  note.status = 'resolved'
  note.closedBy = 'auto'
  note.closedAt = now
}
export function validateSelection(
  value: unknown,
): asserts value is NoteSelection & { do: string; reason?: DismissReason } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid note selection')
  const args = value as NoteSelection & { do?: unknown; reason?: unknown }
  if (
    typeof args.do !== 'string' ||
    !['resolve', 'dismiss', 'reopen', 'archive'].includes(args.do) ||
    !validReason(args.reason) ||
    !['notes', 'conversation', 'role', 'status', 'olderThanDays'].some(
      (key) => args[key as keyof NoteSelection] !== undefined,
    ) ||
    (args.notes !== undefined &&
      (!Array.isArray(args.notes) ||
        !args.notes.length ||
        args.notes.some((n) => typeof n !== 'string'))) ||
    (args.conversation !== undefined &&
      (!Number.isSafeInteger(args.conversation) || args.conversation < 1)) ||
    (args.role !== undefined && !ROLES.includes(args.role)) ||
    (args.status !== undefined && !['open', 'resolved', 'dismissed'].includes(args.status)) ||
    (args.olderThanDays !== undefined &&
      (!Number.isFinite(args.olderThanDays) || args.olderThanDays < 0))
  )
    throw new Error('Invalid note selection')
}
export function selected(note: StoredNote, args: NoteSelection, now: number) {
  if (args.notes) return args.notes.includes(note.id)
  return (
    note.archivedAt === undefined &&
    (args.conversation === undefined || note.conversation === args.conversation) &&
    (args.role === undefined || note.role === args.role) &&
    (args.status === undefined || note.status === args.status) &&
    (args.olderThanDays === undefined || note.at < now - args.olderThanDays * 86_400_000)
  )
}
export function pruneNotes(state: AdvisorStateDoc, now: number) {
  state.notes = state.notes.filter(
    (n) => n.closedAt === undefined || now - n.closedAt < 90 * 86_400_000,
  )
  if (state.notes.length <= 2000) return
  const oldest = state.notes.toSorted(
    (a, b) =>
      Number(b.archivedAt !== undefined) - Number(a.archivedAt !== undefined) || a.at - b.at,
  )
  const remove = new Set(oldest.slice(0, state.notes.length - 2000).map((n) => n.id))
  state.notes = state.notes.filter((n) => !remove.has(n.id))
}
