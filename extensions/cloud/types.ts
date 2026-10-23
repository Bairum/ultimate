/** A finished backup: its snapshot id, when and from which machine, the bytes before compression and those uploaded. */
export interface LastBackup {
  id: string
  at: number
  machine: string
  bytes: number
  uploaded: number
}

/** `cloud.state`: whether backups run here, and this home's last backup, for the status line. */
export interface CloudState {
  /** `off`: not configured; `local`: configured, but the project has no GitHub origin. */
  status: 'off' | 'local' | 'on'
  /** The project's name, the folder name the restore command takes. */
  name: string
  /** The active chapter, whose own backup chain this is. */
  chapter?: { name: string; number: number }
  machine?: string
  /** The backup this home last uploaded or restored from: the parent of its next backup. */
  lastBackup?: LastBackup
  /** The running backup: bytes read of `total` (before compression), and compressed bytes uploaded so far. */
  backup?: { done: number; total: number; uploaded: number }
  /**
   * The last backup was refused: another machine backed up after this home's parent. `error` is the Worker's sentence;
   * `latest` names the backup a forced one replaces, as the Worker's 409 names it.
   */
  conflict?: { error: string; latest?: { id: string; machine: string; at: number } }
  lastError?: string
}
