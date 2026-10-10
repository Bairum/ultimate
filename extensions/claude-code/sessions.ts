import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

export interface SessionRecord {
  id: string
  cwd: string
  handled: string[]
  started?: boolean
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
          if (entries.length) {
            const record = this.get(key.sessionId)
            if (record) {
              record.started = true
              this.put(record)
            }
          }
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
    record.started ||= this.get(record.id)?.started ?? false
    this.db
      .prepare(
        'INSERT INTO sessions (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record',
      )
      .run(record.id, JSON.stringify(record))
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  close() {
    this.db.close()
  }
}

export function killOrphan(pid: number, sessionId: string): string | undefined {
  let command: string
  try {
    process.kill(pid, 0)
    command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  } catch (error) {
    if (
      ['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '') ||
      (error as { status?: number }).status === 1
    )
      return undefined
    return `Could not inspect Claude Code pid ${pid}: ${String(error)}`
  }
  const args = command.trim().split(/\s+/)
  // The Agent SDK passes `--session-id=<id>` / `--resume=<id>`; accept the separate-argument form too.
  const session = args.some((arg, index) =>
    ['--session-id', '--resume'].some(
      (flag) => arg === `${flag}=${sessionId}` || (arg === flag && args[index + 1] === sessionId),
    ),
  )
  if (!session || !/(?:^|[\\/])claude(?:\.exe)?$/i.test(args[0] ?? ''))
    return `Refusing to kill pid ${pid}: not Claude Code session ${sessionId}`
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      return `Could not kill Claude Code pid ${pid}: ${String(error)}`
  }
  return undefined
}
