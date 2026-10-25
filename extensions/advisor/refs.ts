/** Advisor contract shared by server and web: config, documents, entry data, actions and events. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

export const SEVERITIES = ['nit', 'concern', 'blocker'] as const
export type Severity = (typeof SEVERITIES)[number]

/** Roles are agent definition names; `ultimate` is the standing @ultimate conversation. */
export const ROLES = [
  'ultimate',
  'coordinator',
  'worker',
  'designer',
  'scout',
  'reviewer',
  'lander',
  'watcher',
  'dream-pass',
  'computer-operator',
] as const
export type Role = (typeof ROLES)[number]

/** Where a review runs. `rounds` uses `every`; `signals` fires on deterministic risk signals; `idle` on a quiet conversation. */
export const REVIEW_POINTS = ['answer', 'rounds', 'signals', 'idle'] as const
export type ReviewPoint = (typeof REVIEW_POINTS)[number]

/**
 * How notes reach the conversation. `card`: an entry only the user sees (no model message). `note`: a passive entry
 * the agent reads with its next request. Steering and continuing are separate thresholds on top of `note`.
 */
export type Delivery = 'card' | 'note'
/** `never` disables; otherwise the lowest severity that triggers it. */
export type Threshold = Severity | 'never'

/** A named advisor in the roster. Unset fields fall back to the top-level `advisor.model` and the built-in rubric. */
export type AdvisorSpec = {
  /** "provider/id[:thinking]" */
  model?: string
  /** Name of a rubric file (`<name>.md` under an advisors folder); defaults to the advisor's own name. */
  rubric?: string
  /** Read/grep calls per review; default 6, at most 20. */
  maxToolCalls?: number
  /** Non-blocker notes per review; default 3, at most 10. Blockers are exempt. */
  maxNotes?: number
}

/** One role's profile. Every role is off until `enabled: true`. */
export type RoleProfile = {
  enabled?: boolean
  advisors?: string[]
  at?: ReviewPoint[]
  /** Tool rounds between `rounds` reviews; default 5. */
  every?: number
  /** First-pass gate for rounds, signals and idle reviews; final answers are never gated. */
  gate?: 'jev' | 'none'
  /** Default `note` (cards only for `card`). */
  delivery?: Delivery
  /** Lowest severity that continues a held final answer once; default `blocker`. Forced `never` for @ultimate. */
  continueOn?: Threshold
  /** Lowest severity that steers a running agent from a mid-run review; default `never`. Forced `never` for @ultimate. */
  steerOn?: Threshold
  /** After a user or parent input, steering and continuing are suppressed for this long; default 10 min. */
  quietMs?: number
  /** Idle review after this long without activity; default 30 min. */
  idleMs?: number
  /** USD per day for this role; unset means only the global budget applies. */
  dayUsd?: number
}

/** The `advisor` key in settings.json. Layers: built-in defaults < ~/.ultimate < trusted project, merged per key. */
export type AdvisorConfig = {
  model?: string
  advisors?: Record<string, AdvisorSpec>
  roles?: Partial<Record<Role, RoleProfile>>
  /** USD per day across all roles; default 5. */
  dayUsd?: number
}

export type NoteStatus = 'open' | 'resolved' | 'dismissed'
export type Feedback = 'up' | 'down'

/** Data of an `advisor.note` entry: one review's accepted notes. */
export type AdvisorNoteEntry = {
  review: string
  advisor: string
  role: Role
  point: ReviewPoint
  model: string
  delivered: 'card' | 'note' | 'steer' | 'continue'
  notes: { id: string; severity: Severity; note: string; evidence: string }[]
}
export const NOTE_ENTRY = 'advisor.note'

export type StoredNote = {
  id: string
  conversation: number
  entry?: number
  advisor: string
  role: Role
  point: ReviewPoint
  severity: Severity
  note: string
  evidence: string
  at: number
  status: NoteStatus
  feedback?: Feedback
}

export type ConversationActivity = {
  role: Role
  reviews: number
  skipped: number
  notes: Record<Severity, number>
  usd: number
  lastAt?: number
  lastSkip?: string
}

/** On conversation 1: activity, notes (newest last, capped) and spend per UTC day and role. */
export type AdvisorStateDoc = {
  conversations: Record<string, ConversationActivity>
  notes: StoredNote[]
  spend: Record<string, { total: number; roles: Partial<Record<Role, number>> }>
}
export const AdvisorState = docRef<AdvisorStateDoc>('advisor.state')

/** On @ultimate: open promises and user questions the `promises` advisor tracks. */
export type LedgerItem = {
  id: string
  kind: 'promise' | 'question'
  text: string
  since: number
  entry?: number
  dueAt?: number
}
export const AdvisorLedger = docRef<{ items: LedgerItem[] }>('advisor.ledger')

/** The effective config with the layer that set each field, rubrics and validation problems. */
export type ConfigView = {
  effective: AdvisorConfig
  user: AdvisorConfig
  project: AdvisorConfig
  projectTrusted: boolean
  rubrics: { name: string; source: 'builtin' | 'user' | 'project'; text: string }[]
  problems: string[]
}
export const ConfigAction = actionRef<null, ConfigView>('advisor', 'config')
/** User-only and host: replace the `advisor` key of one layer (null removes it). */
export const SetConfigAction = actionRef<
  { scope: 'user' | 'project'; config: AdvisorConfig | null },
  ConfigView
>('advisor', 'setConfig')
/** User-only and host: write or delete (`text: null`) one rubric file. */
export const SetRubricAction = actionRef<
  { scope: 'user' | 'project'; name: string; text: string | null },
  ConfigView
>('advisor', 'setRubric')
/** User-only: thumbs on a note, or change its status. */
export const FeedbackAction = actionRef<
  { note: string; feedback?: Feedback | null; status?: NoteStatus },
  StoredNote
>('advisor', 'feedback')

export const Reviewed = defineEvent<{
  conversation: number
  role: Role
  advisor: string
  point: ReviewPoint
  notes: number
  usd: number
  skipped?: string
}>('advisor.reviewed')
