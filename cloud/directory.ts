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
