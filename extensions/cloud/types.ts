import type { Transition, Writer } from '../../cloud/protocol.ts'

/** The provider this machine runs the project's agents with, and whether it has credentials here. */
export interface ModelLogin {
  provider: string
  ok: boolean
  /** Why a configured provider does not count: its latest call on this machine failed with this error. */
  error?: string
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
  /** While sync runs: the model login this machine's agents run with; a move here fails its checks without one. */
  login?: ModelLogin
  lastError?: string
}
