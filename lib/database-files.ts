// A project home's database files, shared by cloud backups, `pnpm reset` and `pnpm restore`.
import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

/** A SQLite database's files: the database, its write-ahead log and its shared-memory index. */
export const databaseSuffixes = ['', '-wal', '-shm']

/** Move a SQLite database with its `-wal` and `-shm`; never deletes one. */
export async function moveDatabase(from: string, to: string) {
  for (const suffix of databaseSuffixes)
    if (existsSync(from + suffix)) await rename(from + suffix, to + suffix)
}

/** A fresh, compact copy of the logical content, including committed WAL frames; the same content gives the same bytes. */
export function vacuum(database: string, copy: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    db.prepare('VACUUM INTO ?').run(copy)
  } finally {
    db.close()
  }
}
