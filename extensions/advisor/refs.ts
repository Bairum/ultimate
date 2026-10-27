/** Advisor contract shared by server and web: config, documents, entry data, actions and events. Browser-safe. */
/* oxlint-disable ultimate/api-file-shape -- Shared browser-safe enum constants are part of this extension's public contract. */
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
  'codex-operator',
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

/**
 * Why notes went where they did. `continue`/`steer`: they interrupted the agent (or rode with that continuation).
 * `threshold`: below continueOn/steerOn. `cap`: the run was already continued once. `quiet`: a user or parent input
 * arrived within quietMs. `ended`: the reviewed run had finished. `deadline`: the answer review overran the hold, so the
 * answer left first and a background review followed. `default`: the role's delivery.
 */
export type DeliveryReason =
  | 'continue'
  | 'steer'
  | 'threshold'
  | 'cap'
  | 'quiet'
  | 'ended'
  | 'deadline'
  | 'default'

/**
 * Data of an `advisor.note` entry: one review's accepted notes. A routed review writes two entries: a card in the
 * reviewed conversation with `routedTo`, and the delivered entry in that parent with `from`.
 */
export type AdvisorNoteEntry = {
  review: string
  advisor: string
  role: Role
  point: ReviewPoint
  model: string
  delivered: 'card' | 'note' | 'steer' | 'continue'
  notes: { id: string; ref?: string; severity: Severity; note: string; evidence: string }[]
  reason?: DeliveryReason
  /** On the reviewed conversation's card: the parent its notes went to instead. */
  routedTo?: number
  /** On the parent's entry: the reviewed child the notes are about. */
  from?: number
}
export const NOTE_ENTRY = 'advisor.note'

/**
 * What the agent did with a note. `addressed`, `deferred` and `disputed` come from the agent's acknowledgement
 * (`ack`) or, without one, from a judge over the entries after delivery (`judged`). `ignored`: read, no response by the
 * end of the run. `unread`: never reached a request before the conversation finished. `late`: delivered after the
 * agent's last run ended (never for notes routed to a parent). Cards go to the user only and get no response.
 */
export const RESPONSES = ['addressed', 'deferred', 'disputed', 'ignored', 'unread', 'late'] as const
export type ResponseStatus = (typeof RESPONSES)[number]
export type NoteResponse = {
  status: ResponseStatus
  source: 'ack' | 'judged' | 'auto'
  /** The agent's stated reason, or the judge's summary. */
  reason?: string
  /** Entry ids, commits or tool calls showing it. */
  evidence?: string
  at: number
  /** For `judged`: TypeSafe's Jev typed judgment, or the advisor model when Jev was unsure or unavailable. */
  judge?: 'jev' | 'sol'
  /** Jev's confidence in its choice, 0–1 (also kept when it fell below the threshold and the advisor model decided). */
  confidence?: number
  /** The judging model, e.g. `jev-1.14.0` or `openai-codex/gpt-6.1-sol`. */
  model?: string
}

export type StoredNote = {
  id: string
  /**
   * Short handle the agent cites in its acknowledgement: `advisor <ref>: addressed|deferred|disputed — reason`.
   * Absent on notes stored before lifecycle tracking.
   */
  ref?: string
  /** The reviewed conversation (the subject), even when routed. */
  conversation: number
  /** The parent that received the note instead of `conversation`, which could no longer act on it. */
  routedTo?: number
  reason?: DeliveryReason
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
  delivered?: AdvisorNoteEntry['delivered']
  /** When a model request first carried the note (a continuation counts as read at delivery). */
  readAt?: number
  response?: NoteResponse
  /** Who closed it (resolved or dismissed): the user, or the automatic close-out. */
  closedBy?: 'user' | 'auto'
  closedAt?: number
  /** The user's reason for a dismissal; feeds audits as "dismissed by user". */
  dismissReason?: DismissReason
  /** Hidden from open views and the chip until then; still open. */
  snoozedUntil?: number
  /** Cleared from the panel's views; kept for stats and audits until pruned 90 days after closing. */
  archivedAt?: number
}
export const DISMISS_REASONS = ['false-alarm', 'handled', 'wont-fix'] as const
export type DismissReason = (typeof DISMISS_REASONS)[number]

/**
 * Lifecycle counts for one role over a window. `dismissed` counts user dismissals, apart from agent responses.
 * `routed`: notes sent to the parent; `routedAddressed`: those its parent addressed (also counted in `addressed`).
 */
export type RoleStats = {
  delivered: number
  read: number
  dismissed: number
  routed: number
  routedAddressed: number
} & Record<ResponseStatus | 'pending', number>
/** Review duration percentiles in milliseconds, per `role:point`, including silent and skipped reviews. */
export type Latency = Record<string, { n: number; p50: number; p90: number; max: number }>
/** Read-only `{ days? }` (default 7) → lifecycle counts per role and review latency, for the panel and audits. */
export const StatsAction = actionRef<
  { days?: number } | null,
  { since: number; roles: Partial<Record<Role, RoleStats>>; latency: Latency }
>('advisor', 'stats')
/** Which notes a bulk action touches: explicit ids, or every unarchived note matching all given filters. */
export type NoteSelection = {
  notes?: string[]
  conversation?: number
  role?: Role
  status?: NoteStatus
  olderThanDays?: number
}
/**
 * User-only bulk management. `resolve` / `dismiss` close open notes (dismiss takes an optional reason); `reopen`
 * reopens; `archive` clears closed notes from the panel (never the transcript's entries). Returns how many changed.
 */
export const ManageAction = actionRef<
  NoteSelection & {
    do: 'resolve' | 'dismiss' | 'reopen' | 'archive'
    reason?: DismissReason
  },
  { changed: number }
>('advisor', 'manage')

export type ConversationActivity = {
  role: Role
  reviews: number
  skipped: number
  notes: Record<Severity, number>
  usd: number
  lastAt?: number
  lastSkip?: string
}

/** One review task's duration: every advisor of the role, as the agent waited for it at a held answer. */
export type Timing = {
  task: number
  at: number
  role: Role
  point: ReviewPoint
  ms: number
  skipped?: string
}

/** On conversation 1: activity, notes (newest last, capped) and spend per UTC day and role. */
export type AdvisorStateDoc = {
  conversations: Record<string, ConversationActivity>
  notes: StoredNote[]
  spend: Record<string, { total: number; roles: Partial<Record<Role, number>> }>
}
/** Root conversation activity, retained notes and daily spend. */
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
/** On @ultimate: open promises and unanswered questions. */
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
/** No arguments; returns effective settings, layers, rubrics and validation problems. */
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
/**
 * User-only: thumbs on a note, change its status (a dismissal takes an optional `reason`), or snooze it until a time
 * (`snoozeUntil: null` wakes it).
 */
export const FeedbackAction = actionRef<
  {
    note: string
    feedback?: Feedback | null
    status?: NoteStatus
    reason?: DismissReason
    snoozeUntil?: number | null
  },
  StoredNote
>('advisor', 'feedback')

/** One advisor's review or skip, including role, note count, response cost and its duration. */
export const Reviewed = defineEvent<{
  conversation: number
  role: Role
  advisor: string
  point: ReviewPoint
  notes: number
  usd: number
  ms: number
  skipped?: string
  reason?: DeliveryReason
  routedTo?: number
}>('advisor.reviewed')
/** Who acts on a note: the parent it was routed to, else the reviewed conversation. */
export const recipient = (note: { conversation: number; routedTo?: number }) =>
  note.routedTo ?? note.conversation
