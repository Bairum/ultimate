import type { Transition } from '../../cloud/protocol.ts'
import type { CloudState, SyncProgress } from '../cloud/types.ts'

/** A project home on this machine, as `fleet` sees it. */
export interface LocalProject {
  root: string
  home: string
  /** The running server, when it runs. */
  url?: string
  role?: CloudState['role']
  status?: CloudState['status']
  sync?: SyncProgress
  /** Secret names the writer has and this machine lacks. */
  missing: string[]
  /** `state.stale-*.sqlite` files in the project home. */
  stale: string[]
  /** `refs/heads/ultimate-moved/*` refs a move kept aside in the checkout. */
  keptRefs: string[]
}

export interface FleetProject {
  /** `github.com/<owner>/<repo>`, or the home's folder name for a local project the cloud does not know. */
  key: string
  name: string
  writer: { machine: string | null; online: boolean; lastSeen?: number }
  standbys: { machine: string; connected: boolean; lastSeen: number }[]
  transition?: Transition
  local?: LocalProject
}

/** `fleet`: every machine and project the cloud knows, merged with what this machine has locally. */
export interface Fleet {
  machine: string
  machines: { machine: string; online: boolean; projects: number }[]
  projects: FleetProject[]
  /** Why the cloud's directory could not be read; the local projects still show. */
  error?: string
}

/** A `sync.move` input: a move involving this machine ended. */
export interface MoveEnded {
  project: { key: string; name: string; root: string }
  machine: string
  transition: Transition
}

/** A `sync.report` input in a project's @ultimate. */
export interface SyncReport {
  from: string
  text: string
}
