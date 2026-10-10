import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

export interface SessionRecord {
  id: string
  cwd: string
  handled: string[]
  turn?: { keys: string[]; prompt: string }
  bridge?: import('./bridge.ts').BridgeCall[]
  pid?: number
  totalCost?: number
  result?: {
    text: string
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
  }
}

const keyId = (key: SessionKey) =>
  JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null])

export class Sessions {
  readonly db: DatabaseSync
  readonly mirror: SessionStore

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, uuid TEXT, entry TEXT NOT NULL, UNIQUE(key, uuid));`)
    this.mirror = {
      append: async (key, entries) => {
        const insert = this.db.prepare(
          'INSERT OR IGNORE INTO entries (key, uuid, entry) VALUES (?, ?, ?)',
        )
        this.db.exec('BEGIN IMMEDIATE')
        try {
          for (const entry of entries)
            insert.run(keyId(key), entry.uuid ?? null, JSON.stringify(entry))
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
      },
      load: async (key) => {
        const rows = this.db
          .prepare('SELECT entry FROM entries WHERE key = ? ORDER BY seq')
          .all(keyId(key)) as { entry: string }[]
        return rows.length ? rows.map((row) => JSON.parse(row.entry) as SessionStoreEntry) : null
      },
    }
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT record FROM sessions WHERE id = ?').get(id) as
      | { record: string }
      | undefined
    return row ? (JSON.parse(row.record) as SessionRecord) : undefined
  }

  put(record: SessionRecord) {
    this.db
      .prepare(
        'INSERT INTO sessions (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record',
      )
      .run(record.id, JSON.stringify(record))
  }

  close() {
    this.db.close()
  }
}

export function killOrphan(pid: number) {
  let command: string
  try {
    process.kill(pid, 0)
    command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  } catch (error) {
    if (
      ['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '') ||
      (error as { status?: number }).status === 1
    )
      return
    throw error
  }
  if (!command.toLowerCase().includes('claude'))
    throw new Error(`Refusing to kill pid ${pid}: not a Claude process`)
  process.kill(pid, 'SIGKILL')
}
