/**
 * Cloud: the extension point through which the writer lease reports what the user should hear about, a finished or
 * failed backup and a move that ended here, to whoever listens (sync's @sync).
 */
import type { Transition } from '../../cloud/protocol.ts'
import { defineApi } from '../../shared/extension-api.ts'
import type { BackupReport } from './types.ts'

export type { BackupReport }
export { BackupEvent, LeaseChanged, MoveEvent } from './refs.ts'

/** What the lease reports; each call is one event, made once and outside any socket handler. */
export interface FeedbackService {
  /** A backup of this project finished or failed on this machine. */
  backup(report: BackupReport): Promise<void>
  /** A move to this machine finished: it serves project `key` as the writer now, with storage open. */
  moved(input: { key: string; machine: string; transition: Transition }): Promise<void>
}
/** The lease's feedback point; sync provides it, cloud `want`s it. */
export const Feedback = defineApi<FeedbackService>()('cloud.feedback')
