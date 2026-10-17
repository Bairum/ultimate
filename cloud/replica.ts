import type { ConversationRecord, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import type { CloudMessage, MachineMessage, OutboxItem } from './protocol.ts'
import type { ConversationSummary } from '../shared/protocol.ts'

/** The common subset of Durable Object SQL and a node:sqlite adapter. */
export interface Sql {
  exec<T extends Record<string, unknown>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): Iterable<T>
  transaction<T>(run: () => T): T
}

export class ReplicaStore {
  readonly sql: Sql
  constructor(sql: Sql) {
    this.sql = sql
    for (const table of ['conversations', 'metadata', 'summaries'])
      sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`)
    sql.exec(
      'CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, value TEXT NOT NULL)',
    )
    sql.exec('CREATE INDEX IF NOT EXISTS entries_conversation ON entries (conversation_id, id)')
    sql.exec(
      'CREATE INDEX IF NOT EXISTS entry_heads_conversation ON entries (conversation_id, id) WHERE head IS NOT NULL',
    )
    sql.exec(
      'CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL, value TEXT NOT NULL)',
    )
    sql.exec('CREATE INDEX IF NOT EXISTS docs_conversation_kind ON docs (conversation_id, kind)')
    sql.exec(
      'CREATE TABLE IF NOT EXISTS outbox (submissionId INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id INTEGER NOT NULL, value TEXT NOT NULL)',
    )
    sql.exec(
      'CREATE INDEX IF NOT EXISTS outbox_conversation ON outbox (conversation_id, submissionId)',
    )
  }

  private put(table: string, id: number, value: unknown) {
    this.sql.exec(
      `INSERT INTO ${table} (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
      id,
      JSON.stringify(value),
    )
  }
  private get(table: string, id: number): unknown {
    const row = [
      ...this.sql.exec<{ value: string }>(`SELECT value FROM ${table} WHERE id=?`, id),
    ][0]
    return row ? JSON.parse(row.value) : undefined
  }
  metadata(id: number): unknown {
    return this.get('metadata', id)
  }
  identity(): { machine: string; project: string; port: number; uiBuild?: string } | undefined {
    return this.metadata(5) as ReturnType<ReplicaStore['identity']>
  }
  key(): string | undefined {
    return this.metadata(6) as string | undefined
  }
  claimKey(machine: string, project: string): boolean {
    const key = JSON.stringify([machine, project])
    if (this.key() && this.key() !== key) return false
    this.put('metadata', 6, key)
    return true
  }
  hasEntries(): boolean {
    return [...this.sql.exec('SELECT id FROM entries LIMIT 1')].length > 0
  }
  summaryCount(): number {
    return [...this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM summaries')][0].count
  }
  summaries(): ConversationSummary[] {
    return [...this.sql.exec<{ value: string }>('SELECT value FROM summaries ORDER BY id')].map(
      (row) => JSON.parse(row.value) as ConversationSummary,
    )
  }
  /** Adopt existing trial data on first hello; later hosts must name the same project. */
  claimProject(project: string): string {
    return this.sql.transaction(() => {
      const held = this.metadata(4) as string | undefined
      if (held !== undefined) return held
      this.put('metadata', 4, project)
      return project
    })
  }
  conversation(id: number): ConversationRecord | undefined {
    return this.get('conversations', id) as ConversationRecord | undefined
  }
  root() {
    return (
      [...this.sql.exec<{ id: number | null }>('SELECT MIN(id) AS id FROM conversations')][0].id ??
      1
    )
  }
  doc(conversationId: number, kind: string): JsonObject | null {
    const row = [
      ...this.sql.exec<{ value: string }>(
        'SELECT value FROM docs WHERE conversation_id=? AND kind=? ORDER BY id LIMIT 1',
        conversationId,
        kind,
      ),
    ][0]
    return row ? (JSON.parse(row.value) as JsonObject) : null
  }
  cursor(): Extract<CloudMessage, { type: 'cursor' }> {
    const entries = this.sql.exec<{ conversation_id: number; id: number }>(
      'SELECT conversation_id, MAX(id) AS id FROM entries GROUP BY conversation_id',
    )
    return {
      type: 'cursor',
      entries: Object.fromEntries([...entries].map((row) => [row.conversation_id, row.id])),
      docs: Object.fromEntries(
        [...this.sql.exec<{ id: number; hash: string }>('SELECT id, hash FROM docs')].map((doc) => [
          doc.id,
          doc.hash,
        ]),
      ),
    }
  }
  outbox(): OutboxItem[] {
    return [
      ...this.sql.exec<{ value: string }>('SELECT value FROM outbox ORDER BY submissionId'),
    ].map((row) => JSON.parse(row.value) as OutboxItem)
  }
  enqueue(conversationId: number, text: string, whenBusy?: OutboxItem['whenBusy']) {
    const item: OutboxItem = {
      id: crypto.randomUUID(),
      conversationId,
      text,
      whenBusy,
      createdAt: Date.now(),
    }
    this.sql.exec(
      'INSERT INTO outbox (id, conversation_id, value) VALUES (?, ?, ?)',
      item.id,
      conversationId,
      JSON.stringify(item),
    )
    const row = [
      ...this.sql.exec<{ submissionId: number }>(
        'SELECT submissionId FROM outbox WHERE id=?',
        item.id,
      ),
    ][0]
    // Negative IDs distinguish cloud queue items from the machine's positive Pi submission IDs.
    return { item, submissionId: -row.submissionId }
  }
  receive(message: MachineMessage): CloudMessage[] {
    switch (message.type) {
      case 'hello':
        this.put('metadata', 5, {
          machine: message.machine,
          project: message.project,
          port: message.port,
          uiBuild: message.uiBuild ?? this.identity()?.uiBuild,
        })
        return [this.cursor(), { type: 'outbox', items: this.outbox() }]
      case 'uiBuild':
        if (/^[a-f0-9]{12}$/.test(message.value) && this.identity())
          this.put('metadata', 5, { ...this.identity(), uiBuild: message.value })
        return []
      case 'batch':
        this.sql.transaction(() => {
          for (const record of message.conversations) this.put('conversations', record.id, record)
          for (const entry of message.entries)
            this.sql.exec(
              'INSERT INTO entries (id, conversation_id, head, value) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id, head=excluded.head, value=excluded.value',
              entry.id,
              entry.conversationId,
              entry.head ?? null,
              JSON.stringify(entry),
            )
          for (const doc of message.docs) {
            if (doc.value === null) this.sql.exec('DELETE FROM docs WHERE id=?', doc.id)
            else
              this.sql.exec(
                'INSERT INTO docs (id, conversation_id, kind, hash, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id, kind=excluded.kind, hash=excluded.hash, value=excluded.value',
                doc.id,
                doc.conversationId,
                doc.kind,
                doc.hash,
                JSON.stringify(doc.value),
              )
          }
        })
        return [{ type: 'ack', batch: message.batch }]
      case 'summaries':
        this.sql.transaction(() => {
          if (message.full) this.sql.exec('DELETE FROM summaries')
          for (const id of message.removed) this.sql.exec('DELETE FROM summaries WHERE id=?', id)
          for (const summary of message.value) this.put('summaries', summary.id, summary)
        })
        break
      case 'system':
        this.put('metadata', 2, message.value)
        break
      case 'models':
        this.put('metadata', 3, message.value)
        break
      case 'delivered':
        this.sql.exec('DELETE FROM outbox WHERE id=?', message.id)
        break
    }
    return []
  }
  /** Each ancestor inherits the tighter of its fork point and the descendant's visible bound. */
  private segments(id: number, record = this.conversation(id)) {
    const segments: { conversationId: number; maxId: number }[] = []
    let maxId = Number.MAX_SAFE_INTEGER
    while (record) {
      segments.push({ conversationId: record.id, maxId })
      const parent = record.parent
      if (!parent) break
      maxId = Math.min(maxId, parent.at)
      record = this.conversation(parent.conversationId)
    }
    return segments
  }
  private entries(query: string, ...bindings: number[]): EntryRecord[] {
    return [...this.sql.exec<{ value: string }>(query, ...bindings)].map(
      (row) => JSON.parse(row.value) as EntryRecord,
    )
  }
  view(id: number) {
    const conversation = this.conversation(id)
    if (!conversation) return null
    const segments = this.segments(id, conversation)
    let marker: EntryRecord | undefined
    for (const segment of segments) {
      const candidate = this.entries(
        'SELECT value FROM entries WHERE conversation_id=? AND id<=? AND head IS NOT NULL ORDER BY id DESC LIMIT 1',
        segment.conversationId,
        segment.maxId,
      )[0]
      if (candidate && (!marker || candidate.id > marker.id)) marker = candidate
    }
    const active = segments
      .flatMap((segment) =>
        this.entries(
          'SELECT value FROM entries WHERE conversation_id=? AND id<=? AND id>=? AND head IS NULL ORDER BY id',
          segment.conversationId,
          segment.maxId,
          marker?.head ?? 0,
        ),
      )
      .toSorted((a, b) => a.id - b.id)
    const entries = marker ? [marker, ...active] : active
    const docs: Record<string, JsonObject> = {}
    for (const doc of this.sql.exec<{ kind: string; value: string }>(
      "SELECT kind, value FROM docs WHERE conversation_id=? AND kind GLOB 'pi.*' AND kind!='pi.live' ORDER BY id",
      id,
    ))
      docs[doc.kind] = JSON.parse(doc.value) as JsonObject
    const queued = [
      ...this.sql.exec<{ submissionId: number; value: string }>(
        'SELECT submissionId, value FROM outbox WHERE conversation_id=? ORDER BY submissionId',
        id,
      ),
    ].flatMap((row) => {
      const item = JSON.parse(row.value) as OutboxItem
      return [{ id: -row.submissionId, mode: item.whenBusy ?? 'followUp', content: item.text }]
    })
    docs['pi.inbox'] = {
      items: [...(Array.isArray(docs['pi.inbox']?.items) ? docs['pi.inbox'].items : []), ...queued],
    }
    return { conversation, entries, docs }
  }
  history(id: number, before: number) {
    const all = this.segments(id)
      .flatMap((segment) =>
        this.entries(
          'SELECT value FROM entries WHERE conversation_id=? AND id<=? AND id<? ORDER BY id DESC LIMIT 65',
          segment.conversationId,
          segment.maxId,
          before,
        ),
      )
      .toSorted((a, b) => b.id - a.id)
    const entries = all.slice(0, 64)
    return { entries, ...(all.length > 64 ? { before: entries.at(-1)!.id } : {}) }
  }
}

/** Check the browser's original authority before rewriting headers for the machine's loopback gate. */
export function admitsRequest(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site')
  const origin = request.headers.get('Origin')
  return (
    (site === null || site === 'same-origin' || site === 'none') &&
    (origin === null || origin === new URL(request.url).origin)
  )
}

/** Strip edge/browser forwarding metadata before passing the request to Ultimate's loopback admission gate. */
export function proxyRequest(request: Request, origin: string): Request {
  if (!admitsRequest(request)) throw new Error('Forbidden')
  const url = new URL(request.url)
  const target = new URL(origin)
  const headers = new Headers(request.headers)
  // Snapshot the keys: deleting while iterating Headers skips adjacent fields.
  const keys = [...headers.keys()]
  for (const key of keys)
    if (/^(x-forwarded-|cf-|sec-fetch-)/i.test(key) || key === 'forwarded') headers.delete(key)
  headers.set('Host', target.host)
  if (headers.has('Origin')) headers.set('Origin', target.origin)
  return new Request(new URL(url.pathname + url.search, target), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
    ...(request.body ? { duplex: 'half' } : {}),
  })
}
