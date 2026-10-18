// The sync WebSocket between the machines running one project and its cloud replica (a Durable Object).
//
// A project is its GitHub repository: the key `github.com/<owner>/<repo>`, with the repository's root commit as a
// sanity check. Several machines may connect for one project, but exactly one is its writer, recorded in the replica
// with a lease epoch. The writer owns the Pi Durable storage; the replica is a read copy plus an outbox. Data flows one
// way, writer to cloud, except outbox items, which the writer submits with `requestId: item.id` so Pi admits each
// exactly once. Every other machine is a standby: it keeps its socket only to hear about the writer.
//
// Order of a connection:
// 1. The machine connects to `/sync/v2?project=<key>` with `Authorization: Bearer <token>` and sends `hello` with the
//    same key, the root commit, its machine name, local HTTP port and the lease epoch it holds, if any.
//    A different root commit, or a malformed hello, closes with `PROJECT_MISMATCH`.
//    The machine then stops reconnecting and tells the user, since retrying cannot succeed.
// 2. The cloud answers `role`. The first hello for an unknown key registers that machine as the writer at epoch 1.
//    The writer machine is the writer again, at the writer's root, when it names the stored epoch, or no epoch at all
//    (a lost lease file); it stores the epoch it is told. Any other machine or checkout, or one naming another epoch,
//    is a standby: it sends nothing
//    but its hello, `claim` and `secrets`, and the cloud ignores anything else it sends. Standbys get `role` again whenever the
//    writer, its online state or the lease changes. Steps 3 to 6 are the writer's alone.
//    The lease only changes hands explicitly. A disconnect never frees it: an offline writer stays the writer. The
//    writer frees it with `release` after uploading a snapshot; the lease keeps its epoch and the snapshot, and every
//    socket hears `role` with `free: true`. A standby then sends `claim` with that epoch: if the lease is still free
//    at that epoch, the claimant becomes the writer at epoch + 1 and gets `role`, `cursor` and `outbox` as after a
//    hello; otherwise it gets `role: 'standby'` again. A standby that wants the lease while the writer holds it sends
//    `request-release`; the cloud forwards it to the writer as `release-requested`. The writer releases once its
//    running tasks finish and its worktrees hold no uncommitted changes (unless the move is forced), telling the
//    requester with `release-waiting` while it waits, and the requester claims.
//    A machine taking the lease first prepares (`Transition`) and reports each step with `transition`; the cloud
//    keeps the latest and sends it in every `role`, to every socket. The cloud UI starts a move with `move-to` and
//    stops one with `cancel`, both sent to the target machine's standby socket.
// 3. The cloud answers `cursor`: per conversation, the newest of its own entries it holds, and the hash of every
//    document it holds.
// 4. The machine subscribes to commits first (buffering them), then sends catch-up `batch`es, reading page by page
//    outside any commit and never more than the unacknowledged window ahead: every conversation record, each
//    conversation's own entries newer than its cursor value in ascending order, and every current conversation-scoped
//    document whose hash differs or which the cloud lacks (and a retirement, `value: null`, for one the cloud holds but
//    the machine no longer has). Then it flushes the buffered commits and keeps sending live `batch`es in commit order.
// 5. The cloud applies each batch atomically, in order, and answers `ack` with its `batch` number. The machine keeps at
//    most a few batches unacknowledged.
// 6. The cloud sends `outbox` with every undelivered item at connect and whenever one is added; the machine answers
//    `delivered` once Pi admitted the submission, and the cloud deletes the item.
//
// Entry IDs come from one counter allocated by Pi's serialized commits, so each conversation's entries arrive in
// ascending order, catch-up and live alike, and a conversation's cursor value never has a gap below it, even when a
// connection drops in the middle of catch-up. Every message is idempotent: applying a record or document twice is
// harmless.

import type { ConversationRecord, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import type { ConversationSummary, SystemInfo } from '../shared/protocol.ts'

/** The current value of one conversation-scoped Pi document incarnation, or its retirement. */
export interface ReplicaDoc {
  /** Pi DocumentId of the incarnation. */
  id: number
  kind: string
  /** Family member key; absent for singleton documents. */
  key?: string
  conversationId: number
  /** `null` retires the incarnation. */
  value: JsonObject | null
  /** `docHash(value)` computed by the machine; the cloud stores it and returns it in `cursor`. */
  hash: string
}

/** A prompt sent from the cloud UI while the machine was offline. */
export interface OutboxItem {
  /** UUID; the machine submits with it as `requestId`. */
  id: string
  conversationId: number
  text: string
  whenBusy?: 'steer' | 'followUp'
  createdAt: number
}

export const PROJECT_MISMATCH = 4009

/** A project key: `github.com/<owner>/<repo>`, lowercased. */
export const PROJECT_KEY = /^github\.com\/[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/

/**
 * A hello's checkout (root, machine and secret names) lives in the replica's socket attachment with the project key
 * and alias (each bounded by `PROJECT_KEY`), which the platform caps at 16 KiB; these bounds keep it far below that. Machines advertise only secret
 * names that fit, never cutting one, and say when they left any out (`secretsComplete: false`).
 */
export const HELLO_LIMITS = {
  root: 1024,
  machine: 128,
  secrets: 64,
  secret: /^[A-Z][A-Z0-9_]{0,63}$/,
}

/**
 * A releasing writer names at most this many worktrees with uncommitted changes, each path at most `path` long; the
 * conversations it waits for are bounded alike.
 */
export const LEFT_LIMITS = { paths: 20, path: 500 }

/** A list of at most `LEFT_LIMITS.paths` strings, each at most `LEFT_LIMITS.path` long, or nothing. */
export const bounded = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= LEFT_LIMITS.paths &&
    value.every((item) => typeof item === 'string' && item.length <= LEFT_LIMITS.path))

/**
 * The handover step's detail while the writer `from` drains: `finishing 2 runs`, then the worktrees with uncommitted
 * changes it waits for (`held`), `waiting for 2 worktrees with uncommitted changes`, or that stay behind on a forced
 * move, `2 worktrees with uncommitted changes stay on haza-pc`.
 */
export function handoverDetail(from: string, tasks: number, left = 0, held = false) {
  const parts: string[] = []
  const worktrees = `${left} ${left === 1 ? 'worktree' : 'worktrees'} with uncommitted changes`
  if (tasks > 0) parts.push(`finishing ${tasks} ${tasks === 1 ? 'run' : 'runs'}`)
  if (left > 0)
    parts.push(
      held
        ? `waiting for ${worktrees}`
        : `${worktrees} ${left === 1 ? 'stays' : 'stay'} on ${from}`,
    )
  return parts.join(' · ')
}

/**
 * Record what a `release-waiting` says on the transition: the conversations still running (`waiting`, cleared once no
 * run is left) and the dirty worktrees (`left`, cleared by an empty list).
 */
export function applyWaiting(
  transition: Pick<Transition, 'left' | 'waiting'>,
  { tasks, dirty, runs }: { tasks: number; dirty?: string[]; runs?: string[] },
) {
  if (runs?.length && tasks > 0) transition.waiting = runs
  else if (tasks === 0) delete transition.waiting
  if (dirty?.length) transition.left = dirty
  else if (dirty) delete transition.left
}

/** One step of preparing a machine to take the lease, in the order they run. */
export interface TransitionStep {
  name: 'fetch' | 'install' | 'checks' | 'handover' | 'download' | 'branches' | 'claim'
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  /** What the step did or why it failed or was skipped. */
  detail?: string
  /** Bytes, for `download`. */
  done?: number
  total?: number
  /** Commits the `fetch` step fast-forwarded. */
  commits?: number
}
/**
 * Who started a move: `local` this machine's own page ("Move here", "Resume here"), `cloud` the cloud UI or its front
 * page behind Access, `sync` @sync (its loopback `moveHere` or the bearer `/sync/move`), `auto` a starting machine
 * taking a free lease (`cloud.autoClaim`).
 */
export type MoveBy = 'local' | 'cloud' | 'sync' | 'auto'
export const MOVE_BY: readonly MoveBy[] = ['local', 'cloud', 'sync', 'auto']
/** "started from the cloud UI", "by @sync", "from rog's page", "automatically": who started `transition`. */
export function startedBy({ by, target }: Pick<Transition, 'by' | 'target'>) {
  if (by === 'cloud') return 'started from the cloud UI'
  if (by === 'sync') return 'by @sync'
  if (by === 'local') return `from ${target}'s page`
  if (by === 'auto') return 'automatically'
  return undefined
}

/** A machine preparing to take the lease (`target`) from the current writer (`from`, null while it is free). */
export interface Transition {
  id: string
  target: string
  from: string | null
  /** Who started it; absent on transitions machines reported before they recorded it. */
  by?: MoveBy
  /** The step running now, or the last one that ran. */
  step: TransitionStep['name']
  steps: TransitionStep[]
  /** Set once the transition failed or was cancelled; the holder is untouched. */
  error?: string
  /** Until the claim is sent. */
  cancellable: boolean
  startedAt: number
  /**
   * Worktrees of the writer's checkout with uncommitted changes: the handover waits for them, or on a forced move they
   * stay on that machine.
   */
  left?: string[]
  /** The conversations whose runs the writer's release waits for, as `#12 title`. */
  waiting?: string[]
}

/** `GET /p/<slug>/api/cloud`: every machine that said hello, the lease and the latest transition. */
export interface CloudInfo {
  machines: {
    machine: string
    role: 'writer' | 'standby'
    /** Has a sync socket open. */
    connected: boolean
    root: string
    lastSeen: number
    /** The writer's secret names this machine lacks. */
    missingSecrets: string[]
  }[]
  lease: {
    machine: string | null
    epoch: number
    root: string
    online: boolean
    snapshot?: { id: string; epoch: number }
  } | null
  transition: Transition | null
}

/** The machine that writes a project's replica, as standbys see it. */
export interface Writer {
  /** Null while the lease is free. */
  machine: string | null
  /** The writer's absolute project root. */
  root: string
  epoch: number
  /** Whether the writer has a sync socket open. */
  online: boolean
  /** Names, never values, of the secrets in the writer's store. */
  secrets: string[]
  /** False when the writer's store holds secrets its hello could not name: a move cannot verify them. */
  secretsComplete: boolean
}

export type Hello = {
  type: 'hello'
  key: string
  /** The repository's oldest root commit; a replica never mixes two repositories under one key. */
  rootCommit: string
  /** Absolute project root on this machine. */
  root: string
  machine: string
  build: string
  uiBuild?: string
  port: number
  /** The lease epoch this machine holds (`<home>/cloud-lease.json`); absent when it holds none. */
  epoch?: number
  /** Whether local storage has any conversation besides the root, or any root entry. */
  history: boolean
  /** Names, never values, of the secrets in this machine's store. */
  secrets: string[]
  /** False when the store holds secrets beyond `HELLO_LIMITS`, which `secrets` leaves out. */
  secretsComplete: boolean
  /** The transition this machine is preparing, if any; another one targeting it has ended. */
  transition?: string
}

export type MachineMessage =
  | Hello
  | {
      type: 'batch'
      batch: number
      conversations: ConversationRecord[]
      entries: EntryRecord[]
      docs: ReplicaDoc[]
    }
  /** Full replacement once per connection, then upserts and removed IDs only. */
  | { type: 'summaries'; value: ConversationSummary[]; removed: number[]; full: boolean }
  | { type: 'uiBuild'; value: string }
  /** The writer frees its lease after uploading snapshot `id`. */
  | { type: 'release'; epoch: number; snapshot: { id: string } }
  /** A standby takes the free lease, naming its epoch. */
  | { type: 'claim'; epoch: number }
  /** A standby asks the writer to release the lease to it, for transition `id`; `force` skips its holds. */
  | { type: 'request-release'; id: string; force?: boolean }
  /** The preparing machine reports its transition; null clears it. */
  | { type: 'transition'; value: Transition | null }
  /**
   * The writer tells the machine `by` that its release waits for `tasks` running tasks of the conversations `runs`,
   * then for the worktrees with uncommitted changes `dirty` (`held`). Right before it releases it names the ones that
   * stay behind on a forced move (`dirty` without `held`, empty once the held ones were committed). Lists are bounded
   * by `LEFT_LIMITS`; `runs` and `held` are absent from writers and Workers that predate them.
   */
  | {
      type: 'release-waiting'
      by: string
      tasks: number
      dirty?: string[]
      runs?: string[]
      held?: boolean
    }
  /** The user's secret names changed since hello; writer and standbys send it, bounded as in hello. */
  | { type: 'secrets'; secrets: string[]; secretsComplete: boolean }
  | { type: 'system'; value: SystemInfo }
  | { type: 'models'; value: unknown }
  | { type: 'delivered'; id: string; submissionId: number }

export type CloudMessage =
  | {
      type: 'role'
      role: 'writer' | 'standby'
      /** The replica's own project key: snapshots are stored and sealed under it, whatever key a machine relinked. */
      project: { key: string }
      epoch: number
      /** The lease is free: a standby may claim it at `epoch`. */
      free: boolean
      /** The snapshot the last release uploaded, and the epoch it was taken at. */
      snapshot?: { id: string; epoch: number }
      writer: Writer
      /** The latest transition, running or ended. */
      transition?: Transition
    }
  | {
      type: 'cursor'
      /** Conversation ID to the newest of its own entries the replica holds; absent conversations hold none. */
      entries: Record<string, number>
      /** Document ID to the hash the replica holds. */
      docs: Record<string, string>
    }
  | { type: 'ack'; batch: number }
  | { type: 'outbox'; items: OutboxItem[] }
  /** To the writer: the standby `by` asked for the lease, for transition `id`; `force` skips the writer's holds. */
  | { type: 'release-requested'; by: string; id: string; force?: boolean }
  /** To a standby, from the cloud UI or @sync's bearer route (`by`): prepare and take the lease as transition `id`. */
  | { type: 'move-to'; id: string; by: Extract<MoveBy, 'cloud' | 'sync'>; force?: boolean }
  /** To the target, from the cloud UI: stop transition `id` if it can still stop. */
  | { type: 'cancel'; id: string }
  /** To the requester `by`: what the writer's release waits for, as the machine sent it. */
  | {
      type: 'release-waiting'
      by: string
      tasks: number
      dirty?: string[]
      runs?: string[]
      held?: boolean
    }

/**
 * One model provider's health on one machine, from real calls and heartbeat pings (`extensions/health`). Times are
 * epoch milliseconds; `error` is the latest failure's short, token-free message.
 */
export interface ProviderHealth {
  provider: string
  state: 'ok' | 'failing' | 'unknown'
  /** The last successful call, real or heartbeat. */
  lastOk?: number
  /** The last failed call, real or heartbeat. */
  lastFail?: number
  error?: string
  /** The last heartbeat ping. */
  lastChecked?: number
  /** The last real (non-heartbeat) call. */
  lastUsed?: number
}

/** A machine's provider health as it reports it to the cloud (`POST /sync/health`) and the cloud lists it. */
export interface MachineHealth {
  machine: string
  /** When the machine sent it. */
  at: number
  providers: ProviderHealth[]
}

/** SHA-256 hex of the JSON text; works in Node and in Workers. */
export async function docHash(value: JsonObject | null): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
