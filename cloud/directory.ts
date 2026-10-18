import type { MachineHealth, ProviderHealth, Transition } from './protocol.ts'
import type { Sql } from './replica.ts'

/** A row of `/api/directory`: one project, wherever it runs. */
export interface Project {
  key: string
  name: string
  slug: string
  /**
   * `machine` is null while the lease is free; `lastSeen` is when the writer last connected or left; `tailnet` is where
   * the writing checkout answers on the tailnet.
   */
  writer: { machine: string | null; online: boolean; lastSeen?: number; tailnet?: string }
  machines: {
    machine: string
    role: 'writer' | 'standby'
    connected: boolean
    lastSeen: number
    tailnet?: string
  }[]
  count: number
  uiBuild?: string
  /** The latest move, running or ended. */
  transition?: Transition
}
export type Presence = Omit<Project, 'slug'> & { hasEntries: boolean }
/** What a machine may report: its name, at most 16 providers, names and errors bounded. */
export const HEALTH_LIMITS = { machine: 64, providers: 16, provider: 64, error: 200 }
const STATES: readonly unknown[] = ['ok', 'failing', 'unknown'] satisfies ProviderHealth['state'][]
const TIMES = ['lastOk', 'lastFail', 'lastChecked', 'lastUsed'] as const
const time = (value: unknown) => value === undefined || Number.isFinite(value)

/**
 * A machine's report reduced to the known fields, the error cut to its limit; undefined when it is malformed. Only
 * these fields are stored, so nothing else a sender includes reaches the table.
 */
export function machineHealth(value: unknown): MachineHealth | undefined {
  const { machine, at, providers } = (value ?? {}) as Partial<Record<keyof MachineHealth, unknown>>
  if (
    typeof machine !== 'string' ||
    !machine.length ||
    machine.length > HEALTH_LIMITS.machine ||
    !Number.isFinite(at) ||
    !Array.isArray(providers) ||
    providers.length > HEALTH_LIMITS.providers
  )
    return undefined
  const valid: ProviderHealth[] = []
  for (const entry of providers as Partial<Record<keyof ProviderHealth, unknown>>[]) {
    const { provider, state, error } = entry ?? {}
    if (
      typeof provider !== 'string' ||
      !provider.length ||
      provider.length > HEALTH_LIMITS.provider ||
      !STATES.includes(state) ||
      (error !== undefined && typeof error !== 'string') ||
      !TIMES.every((key) => time(entry[key]))
    )
      return undefined
    valid.push({
      provider,
      state: state as ProviderHealth['state'],
      ...Object.fromEntries(
        TIMES.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]),
      ),
      ...(error === undefined ? {} : { error: error.slice(0, HEALTH_LIMITS.error) }),
    })
  }
  return { machine, at: at as number, providers: valid }
}

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
    sql.exec('CREATE TABLE IF NOT EXISTS machines (machine TEXT PRIMARY KEY, value TEXT)')
  }
  /** Store a machine's latest provider health, replacing its previous report. False: the report is malformed. */
  health(value: unknown): boolean {
    const health = machineHealth(value)
    if (!health) return false
    this.sql.exec(
      'INSERT INTO machines (machine, value) VALUES (?, ?) ON CONFLICT(machine) DO UPDATE SET value=excluded.value',
      health.machine,
      JSON.stringify(health),
    )
    return true
  }
  /** Every machine's latest report, by name. */
  healthList(): MachineHealth[] {
    return [...this.sql.exec<{ value: string }>('SELECT value FROM machines ORDER BY machine')].map(
      (row) => JSON.parse(row.value) as MachineHealth,
    )
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
