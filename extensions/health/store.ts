import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProviderHealth } from '../../cloud/protocol.ts'

/** One provider's record in `health.json`; times are epoch milliseconds. */
export interface HealthEntry {
  lastOk?: number
  lastFail?: number
  /** The newest failure's sanitised message. */
  error?: string
  lastChecked?: number
  lastUsed?: number
}

export type HealthFile = { providers: Record<string, HealthEntry> }

/** The machine's health file, shared by every Ultimate home of the user. */
export const healthPath = (userHome: string) => join(userHome, '.ultimate/health.json')

const STAMPS = ['lastOk', 'lastFail', 'lastChecked', 'lastUsed'] as const

/** Words an error summary may keep besides the HTTP status and snake_case error codes. */
const KEYWORDS =
  /^(?:unauthorized|forbidden|expired|revoked|overloaded|timeout|aborted|quota|rate|limit|network|unavailable|E[A-Z]{3,15})$/

/**
 * A structured summary of a failure instead of its text, so no credential can reach `health.json` or the cloud: the
 * first HTTP status, provider error codes in snake_case (`invalid_grant`, `rate_limit_error`) and a few known
 * keywords, in order, without duplicates. Everything from a credential word (`token`, `cookie`, `password`, …) to the
 * end of its line goes first, so a value written there never counts as a code. Anything else is dropped; without a
 * recognisable part it is "request failed".
 */
export function sanitize(error: string) {
  const text = error.replace(
    /(?:bearer|basic|token|cookie|authorization|password|passphrase|secret|api[-_ ]?key|credential)[^\n]*/gi,
    ' ',
  )
  const parts: string[] = []
  // A status code, not a port (`:443`) or part of an address.
  const status = /(?<![\d.:])\b([45]\d\d)\b(?![\d.:])/.exec(text)?.[1]
  if (status) parts.push(status)
  for (const word of text.split(/[^A-Za-z_]+/)) {
    const code = /^[a-z]{2,20}(?:_[a-z]{2,20}){1,4}$/.test(word)
    const keyword = KEYWORDS.test(word) || KEYWORDS.test(word.toLowerCase())
    if ((code || keyword) && !parts.includes(word)) parts.push(word)
    if (parts.length >= 5) break
  }
  return parts.length ? parts.join(' ') : 'request failed'
}

export function state(entry: HealthEntry): ProviderHealth['state'] {
  if (entry.lastFail !== undefined && entry.lastFail > (entry.lastOk ?? 0)) return 'failing'
  return entry.lastOk !== undefined ? 'ok' : 'unknown'
}

/** Each timestamp by its maximum; the error belongs to the newest `lastFail`. */
export function merge(a: HealthEntry, b: HealthEntry): HealthEntry {
  const merged: HealthEntry = {}
  for (const key of STAMPS) {
    const value = Math.max(a[key] ?? -Infinity, b[key] ?? -Infinity)
    if (Number.isFinite(value)) merged[key] = value
  }
  const failed = (b.lastFail ?? -Infinity) >= (a.lastFail ?? -Infinity) ? b : a
  const error = failed.error ?? (failed === b ? a.error : b.error)
  if (merged.lastFail !== undefined && error !== undefined) merged.error = error
  return merged
}

const stamp = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The stored file; a missing or unreadable one is empty. */
export async function readFileHealth(userHome: string): Promise<HealthFile> {
  const text = await readFile(healthPath(userHome), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return '{}'
    },
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A torn or hand-edited file starts over: the next real call or ping rewrites it.
    parsed = {}
  }
  const providers: Record<string, HealthEntry> = {}
  const raw =
    parsed && typeof parsed === 'object' && 'providers' in parsed ? parsed.providers : undefined
  if (raw && typeof raw === 'object')
    for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const fields = value as Record<string, unknown>
      const entry: HealthEntry = {}
      for (const key of STAMPS) {
        const at = stamp(fields[key])
        if (at !== undefined) entry[key] = at
      }
      if (typeof fields.error === 'string') entry.error = sanitize(fields.error)
      providers[provider] = entry
    }
  return { providers }
}

export const toHealth = (file: HealthFile): ProviderHealth[] =>
  Object.entries(file.providers)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([provider, entry]) => ({ provider, state: state(entry), ...entry }))

export async function readHealth(userHome: string): Promise<ProviderHealth[]> {
  return toHealth(await readFileHealth(userHome))
}

const writes = new Map<string, Promise<unknown>>()

/**
 * Merge `update` into `provider`'s entry: read, merge by max timestamp, then write through a same-directory temporary
 * file and an atomic rename. Writes from this process run one at a time; another home's concurrent write can at worst
 * lose one event.
 */
export function record(userHome: string, provider: string, update: HealthEntry) {
  const path = healthPath(userHome)
  const clean = update.error === undefined ? update : { ...update, error: sanitize(update.error) }
  const operation = (writes.get(path) ?? Promise.resolve())
    .catch(() => {
      // The previous caller receives its failure; later writes must still run.
    })
    .then(async () => {
      const file = await readFileHealth(userHome)
      file.providers[provider] = merge(file.providers[provider] ?? {}, clean)
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(file, null, 2) + '\n', { flag: 'wx' })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      return file
    })
  writes.set(path, operation)
  return operation
}
