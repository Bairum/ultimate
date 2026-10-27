/** Answers cached per model, state and question, and the daily spend ledger, in one SQLite file. */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ClassifyAnswer } from './api.ts'
import type { DayStats, UseStats } from './refs.ts'

export const USD_PER_MILLION_INPUT = 0.042

/** JSON with object keys sorted at every level, so equal values always serialize the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** The cache key of one question: the sha256 of the canonical JSON of `{ model, state, question }`. */
export function cacheKey(value: { model: string; state: unknown; question: unknown }) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export type Counts = Partial<Omit<DayStats, 'day' | 'usd'>>

/** One use of a feature or caller: its latency in ms, its USD, and whether the cache answered it whole or it failed. */
export type Use = { ms: number; usd?: number; cached?: boolean; failed?: boolean }

export type Cache = ReturnType<typeof cacheOver>

/**
 * The cache's connection and answer count: what outlives a facet reload. Data and handles only, so the code that uses
 * it (`cacheOver`) is always the current load's.
 */
export type CacheHandle = { db: DatabaseSync; rows?: number }

export const openCacheDatabase = (path: string): CacheHandle => ({
  db: new DatabaseSync(path, { timeout: 5000 }),
})

/** Open (creating) the cache at `path`; beyond `maxRows` answers, the oldest are pruned. */
export const openCache = (path: string, maxRows = 200_000) =>
  cacheOver(openCacheDatabase(path), maxRows)

/** This code's cache over `handle`: creates any table it lacks, then prepares its statements. */
export function cacheOver(handle: CacheHandle, maxRows = 200_000) {
  const { db } = handle
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, answer TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS answers_created ON answers (created);
    CREATE TABLE IF NOT EXISTS days (
      day TEXT PRIMARY KEY,
      requests INTEGER NOT NULL,
      cached_questions INTEGER NOT NULL,
      sent_questions INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uses (
      day TEXT NOT NULL,
      name TEXT NOT NULL,
      calls INTEGER NOT NULL,
      cached INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      ms REAL NOT NULL,
      usd REAL NOT NULL,
      PRIMARY KEY (day, name)
    );
  `)
  const select = db.prepare('SELECT answer FROM answers WHERE key = ?')
  const insert = db.prepare(
    'INSERT OR REPLACE INTO answers (key, answer, created) VALUES (?, ?, ?)',
  )
  const count = db.prepare('SELECT COUNT(*) AS rows FROM answers')
  const prune = db.prepare(
    'DELETE FROM answers WHERE key IN (SELECT key FROM answers ORDER BY created DESC, rowid DESC LIMIT -1 OFFSET ?)',
  )
  const tally = db.prepare(`
    INSERT INTO days (day, requests, cached_questions, sent_questions, input_tokens) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (day) DO UPDATE SET
      requests = requests + excluded.requests,
      cached_questions = cached_questions + excluded.cached_questions,
      sent_questions = sent_questions + excluded.sent_questions,
      input_tokens = input_tokens + excluded.input_tokens
  `)
  const days = db.prepare(
    'SELECT day, requests, cached_questions, sent_questions, input_tokens FROM days WHERE day >= ? ORDER BY day DESC',
  )
  const use = db.prepare(`
    INSERT INTO uses (day, name, calls, cached, failed, ms, usd) VALUES (?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT (day, name) DO UPDATE SET calls = calls + 1, cached = cached + excluded.cached,
      failed = failed + excluded.failed, ms = ms + excluded.ms, usd = usd + excluded.usd
  `)
  const uses = db.prepare(
    'SELECT day, name, calls, cached, failed, ms, usd FROM uses WHERE day >= ? ORDER BY day DESC, name',
  )
  const size = db.prepare(
    'SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()',
  )
  // Counting on every insert would scan the table; count once and prune when inserts pass the cap.
  handle.rows ??= Number(count.get()!.rows)

  return {
    get(key: string): ClassifyAnswer | undefined {
      const row = select.get(key)
      return row ? (JSON.parse(String(row.answer)) as ClassifyAnswer) : undefined
    },
    put(entries: [key: string, answer: ClassifyAnswer][], now = Date.now()) {
      for (const [key, answer] of entries) insert.run(key, JSON.stringify(answer), now)
      handle.rows! += entries.length
      if (handle.rows! > maxRows) {
        prune.run(maxRows)
        handle.rows = Number(count.get()!.rows)
      }
    },
    count(counts: Counts, now = Date.now()) {
      tally.run(
        new Date(now).toISOString().slice(0, 10),
        counts.requests ?? 0,
        counts.cachedQuestions ?? 0,
        counts.sentQuestions ?? 0,
        counts.inputTokens ?? 0,
      )
    },
    /** Count one use of `name` today. */
    use(name: string, { ms, usd = 0, cached = false, failed = false }: Use, now = Date.now()) {
      use.run(new Date(now).toISOString().slice(0, 10), name, +cached, +failed, ms, usd)
    },
    /** The ledgers of the last `span` UTC days (today included), newest first, and the cache's rows and bytes. */
    stats(span: number, now = Date.now()) {
      const since = new Date(now - (span - 1) * 86_400_000).toISOString().slice(0, 10)
      return {
        days: days.all(since).map((row): DayStats => ({
          day: String(row.day),
          requests: Number(row.requests),
          cachedQuestions: Number(row.cached_questions),
          sentQuestions: Number(row.sent_questions),
          inputTokens: Number(row.input_tokens),
          usd: (Number(row.input_tokens) * USD_PER_MILLION_INPUT) / 1e6,
        })),
        cache: { rows: Number(count.get()!.rows), bytes: Number(size.get()!.bytes) },
        uses: uses.all(since).map((row): UseStats => ({
          day: String(row.day),
          name: String(row.name),
          calls: Number(row.calls),
          cached: Number(row.cached),
          failed: Number(row.failed),
          avgMs: Math.round(Number(row.ms) / Number(row.calls)),
          usd: Number(row.usd),
        })),
      }
    },
    close: () => db.close(),
  }
}
