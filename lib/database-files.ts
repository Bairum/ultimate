// A project home's database files and its `cloud-lease.json`, shared by the cloud lease and `pnpm reset`.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** A SQLite database's files: the database, its write-ahead log and its shared-memory index. */
export const databaseSuffixes = ['', '-wal', '-shm']

/** Move a SQLite database with its `-wal` and `-shm`; never deletes one. */
export async function moveDatabase(from: string, to: string) {
  for (const suffix of databaseSuffixes)
    if (existsSync(from + suffix)) await rename(from + suffix, to + suffix)
}

/** Where a parked `state.sqlite` goes: `state.stale-<ISO time>.sqlite` next to it. */
export const staleName = (database: string) =>
  database.replace(/state\.sqlite$/, `state.stale-${new Date().toISOString()}.sqlite`)

/** A fresh, compact copy of the logical content, including committed WAL frames; the same content gives the same bytes. */
export function vacuum(database: string, copy: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    db.prepare('VACUUM INTO ?').run(copy)
  } finally {
    db.close()
  }
}

/** sha256 of the logical content (of a VACUUM INTO copy), used to detect "unchanged since release". */
export async function databaseHash(path: string): Promise<string> {
  const temp = await mkdtemp(join(dirname(path), '.snapshot-'))
  try {
    const copy = join(temp, 'database.sqlite')
    vacuum(path, copy)
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(copy)) hash.update(bytes)
    return hash.digest('hex')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/**
 * `<home>/cloud-lease.json`: the project key and lease epoch this home last held, and the snapshot its last release
 * uploaded with the hash of the database it holds.
 */
export interface LeaseFile {
  key?: string
  epoch?: number
  snapshot?: string
  snapshotHash?: string
}
export const leaseFile = (home: string) => join(home, 'cloud-lease.json')

/** The home's lease file; empty when there is none or it cannot be read. */
export async function readLeaseFile(home: string): Promise<LeaseFile> {
  try {
    return JSON.parse(await readFile(leaseFile(home), 'utf8')) as LeaseFile
  } catch {
    // No lease file yet: nothing is known about the local database.
    return {}
  }
}

export async function writeLeaseFile(home: string, lease: LeaseFile) {
  const path = leaseFile(home)
  await writeFile(`${path}.tmp`, JSON.stringify(lease))
  await rename(`${path}.tmp`, path)
}

/**
 * Record `<home>/state.sqlite` as the snapshot the last release uploaded, so the next claim of that snapshot opens it
 * instead of downloading. Only for a home whose lease file names a released snapshot; false otherwise.
 */
export async function adoptAsReleased(home: string) {
  const lease = await readLeaseFile(home)
  if (!lease.snapshot) return false
  await writeLeaseFile(home, {
    ...lease,
    snapshotHash: await databaseHash(join(home, 'state.sqlite')),
  })
  return true
}
