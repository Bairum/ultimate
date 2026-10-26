import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context, JsonValue } from '@earendil-works/chord'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ConversationRecord, Cursor, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ActionContext } from '../../server/actions.ts'
import { implementAction } from '../../lib/actions.ts'
import { HistoryApi, StatsAction } from './api.ts'
import type { HistoryHit } from './api.ts'

/** The most UTF-8 bytes of text one entry contributes, and the most characters one tool call's arguments do. */
const ENTRY_BYTES = 16 * 1024
const ARGS_CHARS = 1024
/** System prompts repeat in every conversation; durable events copy what their own entries already say. */
const skipped = (kind: string) => kind === 'pi.system' || kind.startsWith('event.')

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
  text, conversation UNINDEXED, entry UNINDEXED, kind UNINDEXED, tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS progress (conversation INTEGER PRIMARY KEY, last_entry INTEGER NOT NULL);
`

/** The index of the open chapter, beside its `state.sqlite`: the first chapter's is `<home>/history.sqlite`. */
const indexPath = (host: ExtensionHost) => join(host.chapter.dir, 'history.sqlite')

/** The searchable text of `entry`: its messages' text and tool calls, or else the strings of its data; thinking and images are left out. */
function entryText(entry: EntryRecord): string {
  if (skipped(entry.kind)) return ''
  const parts: string[] = []
  let size = 0
  const add = (text: string) => {
    if (size >= ENTRY_BYTES || !text) return
    parts.push(text)
    size += text.length + 1
  }
  if (entry.model?.length) {
    for (const message of entry.model) {
      const content = (message as { content?: unknown }).content
      if (typeof content === 'string') add(content)
      else if (Array.isArray(content))
        for (const block of content as { type?: string; text?: string; name?: string }[]) {
          if (block.type === 'text' && typeof block.text === 'string') add(block.text)
          else if (block.type === 'toolCall')
            add(
              `${block.name} ${JSON.stringify((block as { arguments?: unknown }).arguments ?? {}).slice(0, ARGS_CHARS)}`,
            )
        }
    }
  } else {
    const strings = (value: JsonValue | undefined) => {
      if (size >= ENTRY_BYTES) return
      if (typeof value === 'string') add(value)
      else if (Array.isArray(value)) value.forEach(strings)
      else if (value && typeof value === 'object') Object.values(value).forEach(strings)
    }
    strings(entry.data)
  }
  // encodeInto writes whole characters only, so the cut never splits one.
  const bytes = new Uint8Array(ENTRY_BYTES)
  const { written } = new TextEncoder().encodeInto(parts.join('\n'), bytes)
  return new TextDecoder().decode(bytes.subarray(0, written))
}

/**
 * `query` as an FTS5 expression that cannot be a syntax error: each `"phrase"` and each other word becomes a quoted
 * string (inner quotes doubled), joined by implicit AND. Undefined when nothing searchable is left.
 */
function ftsQuery(query: string) {
  const terms = [...query.matchAll(/"([^"]*)"?|(\S+)/g)]
    .map((match) => (match[1] ?? match[2]).trim())
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ') : undefined
}

type Index = {
  db: DatabaseSync
  /** The catch-ups, one after another: the background build and each search's. Never rejects. */
  queue: Promise<void>
  stop: AbortController
  /** Fork parents by conversation, from the last catch-up's listing. */
  parents: Map<number, ConversationRecord['parent']>
}

export default function history(host: ExtensionHost) {
  let index: Index | undefined
  const listConversations = (context: Context) =>
    host.harness().commit(async (tx) => {
      const items: ConversationRecord[] = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 100, cursor)
        items.push(...page.items)
        cursor = page.next
      } while (cursor)
      return items
    }, context)
  /**
   * Index each conversation's entries newer than its progress, a page per transaction. Each entry is indexed once,
   * under the conversation that wrote it: a fork's scan starts after its fork point.
   */
  async function catchUp(open: Index, context: Context) {
    const { db, stop } = open
    const records = await listConversations(context)
    open.parents = new Map(records.map((record) => [record.id, record.parent]))
    const done = new Map(
      db
        .prepare('SELECT conversation, last_entry FROM progress')
        .all()
        .map((row) => [Number(row.conversation), Number(row.last_entry)]),
    )
    const insert = db.prepare(
      'INSERT INTO entries (text, conversation, entry, kind) VALUES (?, ?, ?, ?)',
    )
    const advance = db.prepare(
      'INSERT INTO progress (conversation, last_entry) VALUES (?, ?) ON CONFLICT (conversation) DO UPDATE SET last_entry = excluded.last_entry',
    )
    for (const record of records) {
      if (stop.signal.aborted) return
      const from = Math.max(
        (done.get(record.id) ?? 0) + 1,
        record.parent ? record.parent.at + 1 : 1,
      )
      const conversation = await host.harness().conversation(record.id, context)
      if (!conversation) continue
      let cursor: Cursor | undefined
      do {
        const page = await conversation.entries(
          { minEntryId: from as EntryId, order: 'ascending' },
          100,
          cursor,
          context,
        )
        if (stop.signal.aborted) return
        if (page.items.length) {
          db.exec('BEGIN')
          try {
            for (const entry of page.items) {
              if (entry.conversationId !== record.id) continue
              const text = entryText(entry)
              if (text) insert.run(text, record.id, entry.id, entry.kind)
            }
            advance.run(record.id, page.items.at(-1)!.id)
            db.exec('COMMIT')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
        }
        cursor = page.next
        await setImmediate()
      } while (cursor)
    }
  }
  const queued = (open: Index, context: Context) => {
    const run = open.queue.then(() => catchUp(open, context))
    // Its caller reports the failure; the next catch-up starts from the progress saved so far.
    open.queue = run.catch(() => {})
    return run
  }
  const close = async () => {
    const open = index
    index = undefined
    if (!open) return
    open.stop.abort()
    await open.queue
    open.db.close()
  }
  host.onOpen(async () => {
    await close()
    const db = new DatabaseSync(indexPath(host))
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(SCHEMA)
    const open: Index = {
      db,
      queue: Promise.resolve(),
      stop: new AbortController(),
      parents: new Map(),
    }
    index = open
    // The first build reads the whole store; the server does not wait for it.
    queued(open, BACKGROUND_CONTEXT).catch((error: unknown) => {
      if (!open.stop.signal.aborted) host.notice(`History index failed: ${String(error)}`)
    })
  })
  host.onRelease(close)
  host.onClose(close)
  host.implement(HistoryApi, {
    async search(query, options, context) {
      const open = index
      if (!open) throw new Error('History is not open yet')
      const limit = options.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('limit must be an integer between 1 and 100')
      if (typeof query !== 'string') throw new Error('query must be a string')
      const match = ftsQuery(query)
      if (!match) throw new Error('query has no words to search for')
      await queued(open, context)
      const where: string[] = []
      const args: number[] = []
      if (options.conversationId !== undefined) {
        // The conversation's own entries, then each fork ancestor's up to the point it was forked at.
        let id: number | undefined = options.conversationId
        if (!open.parents.has(id)) throw new Error('Unknown conversation')
        let upTo = Number.MAX_SAFE_INTEGER
        while (id !== undefined) {
          where.push('(conversation = ? AND entry <= ?)')
          args.push(id, upTo)
          const parent: ConversationRecord['parent'] = open.parents.get(id)
          if (parent) upTo = Math.min(upTo, parent.at)
          id = parent?.conversationId
        }
      }
      return open.db
        .prepare(
          `SELECT conversation, entry, kind, -bm25(entries) AS score,
             snippet(entries, 0, '**', '**', '…', 24) AS snippet
           FROM entries WHERE entries MATCH ? ${where.length ? `AND (${where.join(' OR ')})` : ''}
           ORDER BY bm25(entries) LIMIT ?`,
        )
        .all(match, ...args, limit)
        .map((row): HistoryHit => ({
          conversation: Number(row.conversation),
          entry: Number(row.entry),
          kind: String(row.kind),
          score: Number(row.score),
          snippet: String(row.snippet),
        }))
    },
  })
  return defineExtension({ name: 'history' })
}

export const actions = {
  /** Read from the file, so it answers while a build runs and before the harness opens. */
  stats: implementAction(StatsAction, async (_args, { host }: ActionContext) => {
    const path = indexPath(host)
    if (!existsSync(path)) return { entries: 0, conversations: 0, bytes: 0 }
    const bytes = ['', '-wal']
      .map((suffix) => `${path}${suffix}`)
      .filter((file) => existsSync(file))
      .reduce((sum, file) => sum + statSync(file).size, 0)
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const row = db
        .prepare(
          'SELECT count(*) AS entries, count(DISTINCT conversation) AS conversations FROM entries',
        )
        .get()!
      return { entries: Number(row.entries), conversations: Number(row.conversations), bytes }
    } finally {
      db.close()
    }
  }),
}
