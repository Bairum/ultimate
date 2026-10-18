import type { Transition } from './protocol.ts'
import type { Sql } from './replica.ts'

/** A row of `/api/directory`: one project, wherever it runs. */
export interface Project {
  key: string
  name: string
  slug: string
  /** `machine` is null while the lease is free; `lastSeen` is when the writer last connected or left. */
  writer: { machine: string | null; online: boolean; lastSeen?: number }
  machines: { machine: string; role: 'writer' | 'standby'; connected: boolean; lastSeen: number }[]
  count: number
  uiBuild?: string
  /** The latest move, running or ended. */
  transition?: Transition
}
export type Presence = Omit<Project, 'slug'> & { hasEntries: boolean }
const safeSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project'

/** Stable reservations survive forgetting, so a returning project keeps its URL. */
export class DirectoryStore {
  readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, value TEXT)',
    )
    sql.exec('CREATE TABLE IF NOT EXISTS aliases (key TEXT PRIMARY KEY, target TEXT NOT NULL)')
  }
  /** The project key whose replica `key` syncs to after a relink; undefined for an unaliased key. */
  target(key: string): string | undefined {
    return [...this.sql.exec<{ target: string }>('SELECT target FROM aliases WHERE key=?', key)][0]
      ?.target
  }
  /**
   * Sync `key` to `from`'s replica from now on, as after a repository rename. The replica `key` had of its own
   * leaves the list. False: the alias would point at itself.
   */
  alias(key: string, from: string): boolean {
    return this.sql.transaction(() => {
      const target = this.target(from) ?? from
      if (target === key) return false
      this.sql.exec(
        'INSERT INTO aliases (key, target) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET target=excluded.target',
        key,
        target,
      )
      this.sql.exec('UPDATE projects SET value=NULL WHERE key=?', key)
      return true
    })
  }
  list(): Project[] {
    return [
      ...this.sql.exec<{ value: string }>(
        'SELECT value FROM projects WHERE value IS NOT NULL ORDER BY slug',
      ),
    ].map((row) => JSON.parse(row.value) as Project)
  }
  resolve(slug: string): Project | undefined {
    const row = [
      ...this.sql.exec<{ value: string | null }>('SELECT value FROM projects WHERE slug=?', slug),
    ][0]
    return row?.value ? (JSON.parse(row.value) as Project) : undefined
  }
  /** Projects with a connected machine always appear; an offline one with zero synced entries is forgotten. */
  update({ hasEntries, ...value }: Presence) {
    this.sql.transaction(() => {
      // A relinked key's own replica may still report as its last sockets close.
      if (this.target(value.key)) return
      let slug = [
        ...this.sql.exec<{ slug: string }>('SELECT slug FROM projects WHERE key=?', value.key),
      ][0]?.slug
      if (!slug) {
        const base = safeSlug(value.name)
        slug = base
        let suffix = 2
        while ([...this.sql.exec('SELECT key FROM projects WHERE slug=?', slug)].length)
          slug = `${base}-${suffix++}`
        this.sql.exec('INSERT INTO projects (key, slug) VALUES (?, ?)', value.key, slug)
      }
      const connected = value.machines.some((machine) => machine.connected)
      this.sql.exec(
        'UPDATE projects SET value=? WHERE key=?',
        !connected && !hasEntries ? null : JSON.stringify({ ...value, slug }),
        value.key,
      )
    })
  }
}
