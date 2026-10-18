import type { Transition, Writer } from '../../cloud/protocol.ts'

/** The sync connection as operators watch it: catch-up and the acknowledgement window. */
export interface SyncProgress {
  /** The sync socket is open and admitted. */
  connected: boolean
  /** The writer is sending the replica what it lacks after connecting. */
  catchingUp: boolean
  /** Unacknowledged batches plus conversations catch-up has not reached yet. */
  backlog: number
  /** When the replica last acknowledged a batch. */
  lastAckAt?: number
  /** Catch-up's conversations: fully queued, of all the host lists. */
  conversations?: { synced: number; total: number }
}

/** `cloud.state`: whether sync runs, this machine's name and its place in the lease, for the cloud UI. */
export interface CloudState {
  /** `off`: not configured; `local`: configured, but the project has no GitHub origin. */
  status: 'off' | 'local' | 'on'
  machine?: string
  role?: 'writer' | 'standby'
  free: boolean
  writer?: Writer
  /** Secret names the writer has and this machine lacks. */
  missing: string[]
  /** Why "Move here" cannot work right now. */
  blocked?: string
  /** The upload of a release. A move's download shows in its transition. */
  progress?: { kind: 'upload'; done: number; total: number }
  /** The move this machine runs, or else the latest one the cloud reported. */
  transition?: Transition
  /** The last move this machine ran itself, ended or not, also when a newer one shows as `transition`. */
  ran?: Transition
  /** The replica's project key the cloud admitted this machine under; a relinked checkout's differs from its origin's. */
  key?: string
  /** The sync connection's catch-up and backlog. */
  sync?: SyncProgress
  lastError?: string
}
