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

/**
 * The only words an error summary may contain: provider and OAuth error codes, network errors and a few plain words.
 * A fixed list, so nothing from a credential can ever pass, whatever its shape.
 */
const KNOWN = new Set([
  'invalid_grant',
  'invalid_token',
  'invalid_client',
  'invalid_request',
  'invalid_api_key',
  'unauthorized_client',
  'access_denied',
  'authentication_error',
  'permission_error',
  'insufficient_quota',
  'rate_limit_error',
  'rate_limit_exceeded',
  'usage_limit_reached',
  'overloaded_error',
  'api_error',
  'server_error',
  'not_found_error',
  'model_not_found',
  'invalid_request_error',
  'context_length_exceeded',
  'request_too_large',
  'unauthorized',
  'forbidden',
  'expired',
  'revoked',
  'overloaded',
  'timeout',
  'aborted',
  'quota',
  'unavailable',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

/**
 * A structured summary of a failure instead of its text, so no credential can reach `health.json` or the cloud: the
 * HTTP status when the message starts with one or names it (`status 401`, `HTTP 429`), then the words of `KNOWN` it
 * contains, in order, without duplicates. Anything else is dropped; without a recognisable part it is "request failed".
 */
export function sanitize(error: string) {
  const parts: string[] = []
  const status = /^\s*([45]\d\d)\b|\b(?:status|http)[\s:=]*([45]\d\d)\b/i.exec(error)
  if (status) parts.push(status[1] ?? status[2])
  for (const word of error.split(/[^A-Za-z_]+/)) {
    const known = KNOWN.has(word) ? word : KNOWN.has(word.toLowerCase()) ? word.toLowerCase() : ''
    if (known && !parts.includes(known)) parts.push(known)
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
  const clean = update.error === undefined ? update : { ...update, error: sanitize(update.error) }
  return write(userHome, (file) => {
    file.providers[provider] = merge(file.providers[provider] ?? {}, clean)
  })
}

/**
 * Forget `providers`' entries, so each reads `unknown` until its next call or ping: its login was added, replaced or
 * removed, and what the old login did says nothing about the new one.
 */
export function reset(userHome: string, providers: string[]) {
  return write(userHome, (file) => {
    for (const provider of providers) delete file.providers[provider]
  })
}

function write(userHome: string, change: (file: HealthFile) => void) {
  const path = healthPath(userHome)
  const operation = (writes.get(path) ?? Promise.resolve())
    .catch(() => {
      // The previous caller receives its failure; later writes must still run.
    })
    .then(async () => {
      const file = await readFileHealth(userHome)
      change(file)
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
