import type { Sql } from './replica.ts'

export interface Instance {
  machine: string
  project: string
  slug: string
  port: number
  uiBuild?: string
  connected: boolean
  lastSeen: number
  count: number
}
export type Presence = Omit<Instance, 'slug'> & { hasEntries: boolean }
const safeSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'instance'

/** Stable reservations survive forgetting, so a returning project keeps its URL. */
export class DirectoryStore {
  readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS instances (key TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, value TEXT)',
    )
  }
  list(): Instance[] {
    return [
      ...this.sql.exec<{ value: string }>(
        'SELECT value FROM instances WHERE value IS NOT NULL ORDER BY slug',
      ),
    ]
      .map((row) => JSON.parse(row.value) as Instance)
      .toSorted((a, b) => a.machine.localeCompare(b.machine) || a.slug.localeCompare(b.slug))
  }
  resolve(slug: string): Instance | undefined {
    const row = [
      ...this.sql.exec<{ value: string | null }>('SELECT value FROM instances WHERE slug=?', slug),
    ][0]
    return row?.value ? (JSON.parse(row.value) as Instance) : undefined
  }
  update(value: Presence) {
    this.sql.transaction(() => {
      const key = JSON.stringify([value.machine, value.project])
      let slug = [
        ...this.sql.exec<{ slug: string }>('SELECT slug FROM instances WHERE key=?', key),
      ][0]?.slug
      if (!slug) {
        const machine = safeSlug(value.machine)
        const base = `${machine}/${safeSlug(value.project.split('/').filter(Boolean).at(-1) ?? 'project')}`
        slug = base
        let suffix = 2
        while ([...this.sql.exec('SELECT key FROM instances WHERE slug=?', slug)].length)
          slug = `${base}-${suffix++}`
        this.sql.exec('INSERT INTO instances (key, slug) VALUES (?, ?)', key, slug)
      }
      this.sql.exec(
        'UPDATE instances SET value=? WHERE key=?',
        !value.connected && !value.hasEntries ? null : JSON.stringify({ ...value, slug }),
        key,
      )
    })
  }
}
