/**
 * Cloud in the browser: this machine's view of the project's cloud lease, and the actions that move the project here
 * or cancel a move. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { CloudState } from './types.ts'

/** No arguments → the lease as the cloud UI shows it: status, role, writer, missing secrets, the running move. */
export const StateAction = actionRef<null, CloudState>('cloud', 'state')
/**
 * `{ force?, by? }` → `{ id }`: prepare this machine and take the project, from a free lease or the online writer;
 * `id` names the move, whose steps `state` follows. `force` continues although the writer has secrets this machine
 * lacks; `by: 'sync'` records @sync as the move's initiator. Fails while cloud sync is off or a move is preparing.
 */
export const MoveHereAction = actionRef<{ force?: boolean; by?: 'local' | 'sync' }, { id: string }>(
  'cloud',
  'moveHere',
)
/**
 * No arguments → the finished backup `{ id, at, bytes }`: upload an encrypted snapshot of the database and the
 * `ultimate/*` branches while this machine keeps the lease. Only on the serving writer, one at a time, never during a
 * move or release.
 */
export const BackupAction = actionRef<null, { id: string; at: number; bytes: number }>(
  'cloud',
  'backup',
)
/** No arguments → `{ ok }`: stop the preparing move, until its claim is sent. */
export const CancelAction = actionRef<null, { ok: boolean }>('cloud', 'cancel')
/**
 * Machine `writer` changed its writer lease at `epoch`: `acquired` (it opened storage as the writer, from standby or a
 * claim; a machine already serving when the cloud names it records none) or `releasing` (it closes storage to hand
 * the lease on). Recorded while storage is open, so the released snapshot carries its own
 * `releasing` to the next writer. A writer the cloud replaced records nothing: its database is parked as it was.
 */
export const LeaseChanged = defineEvent<{
  epoch: number
  writer: string
  change: 'acquired' | 'releasing'
}>('cloud.lease')
/**
 * A backup of project `project` (its key) on the serving writer: `started` when the upload begins, `done` with the
 * bytes before compression and its duration, `failed` with a short classified `reason` (never the raw error).
 */
export const BackupEvent = defineEvent<
  | { phase: 'started'; project: string }
  | { phase: 'done'; project: string; bytes: number; ms: number }
  | { phase: 'failed'; project: string; ms: number; reason: string }
>('cloud.backup')
/**
 * Move `id` of project `project` from `from` (null: the lease was free) to `to`. The writer records `started` when the
 * target asks it to release, and `failed` with the target's failed `step` and a classified `reason` when the move ends
 * and it keeps the project; the target records `done` once it opened storage. A target on standby has no storage, so
 * a move from a free lease records only `done`, and its failures stay in the move card.
 */
export const MoveEvent = defineEvent<
  | { phase: 'started'; project: string; id: string; from: string | null; to: string }
  | { phase: 'done'; project: string; id: string; from: string | null; to: string; ms: number }
  | {
      phase: 'failed'
      project: string
      id: string
      from: string | null
      to: string
      step: string
      reason: string
    }
>('cloud.move')
