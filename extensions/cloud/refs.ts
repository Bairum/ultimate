/**
 * Cloud in the browser: this machine's view of the project's cloud lease, and the actions that move the project here
 * or cancel a move. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'
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
/** No arguments → `{ ok }`: stop the preparing move, until its claim is sent. */
export const CancelAction = actionRef<null, { ok: boolean }>('cloud', 'cancel')
