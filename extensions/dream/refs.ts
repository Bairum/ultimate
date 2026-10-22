/** Dream sessions in the browser: the passes, the journal and the proposals followed to landing. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { PassName } from './types.ts'

export type { PassName } from './types.ts'
export type PassState = { status: 'waiting' | 'running' | 'done' | 'failed'; note?: string }

/**
 * One proposal from a pass. `open` until @ultimate records the user's decision: `approved` with the branch that does it,
 * `applied` for a memory change made at once, `rejected`; an approved branch becomes `landed` with its sha. `retire` is
 * the memory slug a codified proposal makes redundant once it lands.
 */
export type Proposal = {
  id: string
  pass: PassName
  title: string
  size?: string
  risk?: string
  retire?: string
  status: 'open' | 'approved' | 'rejected' | 'applied' | 'landed'
  branch?: number
  sha?: string
}

/** What the dream learned: three lines in @ultimate's voice, then the journal in Markdown. */
export type Journal = { learned: string[]; text: string; at: number }

export type Session = {
  id: number
  startedAt: number
  /** The dream coordinator's branch, from its first pass report. */
  dreamer?: number
  passes: Record<PassName, PassState>
  journal?: Journal
  proposals: Proposal[]
  /** Every proposal settled, or the user ended the session. */
  endedAt?: number
}

/** `{ next, sessions }` on conversation 1, oldest first. */
export const DreamDoc = docRef<{ next: number; sessions: Session[] }>('dream.sessions')

/** `dream.started` and `dream.journal` entries in @ultimate's conversation name their session. */
export type SessionEntry = { session: number }

/** No arguments → `{ session }`: record a session and ask @ultimate to start the dream branch. User-only. */
export const StartAction = actionRef<null, { session: number }>('dream', 'start')
/** `{ session }` → `{ session }`: end a session whatever its proposals' state. User-only. */
export const EndAction = actionRef<{ session: number }, { session: number }>('dream', 'end')
/** `{ session, pass, status, note? }`: the dream coordinator reports a pass; its first report names it the dreamer. */
export const PassAction = actionRef<
  { session: number; pass: PassName; status: PassState['status']; note?: string },
  { session: number }
>('dream', 'pass')
/** `{ session, learned, text, proposals }`: file the journal and show its card in @ultimate's conversation, once. */
export const JournalAction = actionRef<
  {
    session: number
    learned: string[]
    text: string
    proposals: Pick<Proposal, 'id' | 'pass' | 'title' | 'size' | 'risk' | 'retire'>[]
  },
  { session: number; proposals: number }
>('dream', 'journal')
/** `{ session, proposal, status, branch? }`: @ultimate records the user's decision on one proposal. */
export const DecideAction = actionRef<
  {
    session: number
    proposal: string
    status: 'approved' | 'rejected' | 'applied'
    branch?: number
  },
  Proposal
>('dream', 'decide')

/** Calls per tool over the trace's window: how often, how often failing, how slow; and enabled tools never called. */
export type ToolStats = {
  since?: number
  calls: number
  tools: { name: string; calls: number; failed: number; avgMs: number }[]
  unused: string[]
  errors: { name: string; error: string; count: number }[]
}
/** No arguments → tool statistics from `trace.sqlite`, no model involved. */
export const StatsAction = actionRef<null, ToolStats>('dream', 'stats')
