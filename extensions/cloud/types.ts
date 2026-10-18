import type { Transition, Writer } from '../../cloud/protocol.ts'

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
  lastError?: string
}
