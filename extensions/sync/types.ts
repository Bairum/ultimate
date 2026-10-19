import type { ProviderHealth, Transition } from '../../cloud/protocol.ts'
import type { CloudState, ModelLogin } from '../cloud/types.ts'

/** A project home on this machine, as `fleet` sees it. */
export interface LocalProject {
  /** The checkout's GitHub origin key when the cloud admitted it under another (a relinked repository). */
  origin?: string
  root: string
  home: string
  /** The running server, when it runs. */
  url?: string
  role?: CloudState['role']
  status?: CloudState['status']
  /** Secret names the writer has and this machine lacks. */
  missing: string[]
  /** The model login the project's agents run with here; a move here fails without one. */
  login?: ModelLogin
  /** `state.stale-*.sqlite` files in the project home. */
  stale: string[]
  /** `refs/heads/ultimate-moved/*` refs a move kept aside in the checkout. */
  keptRefs: string[]
  /** When this machine last backed the project up, from its `cloud.state`. */
  lastBackupAt?: number
}

export interface FleetProject {
  /** `github.com/<owner>/<repo>`, or the home's folder name for a local project the cloud does not know. */
  key: string
  name: string
  writer: { machine: string | null; online: boolean; lastSeen?: number }
  standbys: { machine: string; connected: boolean; lastSeen: number }[]
  transition?: Transition
  /** When the writer last finished a backup: the cloud's record, or this machine's own when it is the writer. */
  lastBackupAt?: number
  local?: LocalProject
}

/** `fleet`: every machine and project the cloud knows, merged with what this machine has locally. */
export interface Fleet {
  machine: string
  machines: {
    machine: string
    online: boolean
    projects: number
    /** Model provider health: this machine's from `~/.ultimate/health.json`, others' as they last reported it. */
    health?: ProviderHealth[]
  }[]
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
