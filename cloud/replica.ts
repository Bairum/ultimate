import type { ConversationRecord, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import type { CloudMessage, MachineMessage, OutboxItem, ReplicaDoc } from './protocol.ts'

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
    for (const table of ['conversations', 'entries', 'docs', 'metadata'])
      sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`)
    sql.exec(
      'CREATE TABLE IF NOT EXISTS outbox (submissionId INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL)',
    )
  }

  private put(table: string, id: number, value: unknown) {
    this.sql.exec(
      `INSERT INTO ${table} (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
      id,
      JSON.stringify(value),
    )
  }
  private values<T>(table: string): T[] {
    return [...this.sql.exec<{ value: string }>(`SELECT value FROM ${table} ORDER BY id`)].map(
      (row) => JSON.parse(row.value) as T,
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
  root() {
    return this.values<ConversationRecord>('conversations')[0]?.id ?? 1
  }
  doc(conversationId: number, kind: string): JsonObject | null {
    return (
      this.values<ReplicaDoc>('docs').find(
        (doc) => doc.conversationId === conversationId && doc.kind === kind,
      )?.value ?? null
    )
  }
  cursor(): Extract<CloudMessage, { type: 'cursor' }> {
    const row = [...this.sql.exec<{ id: number | null }>('SELECT MAX(id) AS id FROM entries')][0]
    return {
      type: 'cursor',
      maxEntryId: row.id ?? 0,
      docs: Object.fromEntries(this.values<ReplicaDoc>('docs').map((doc) => [doc.id, doc.hash])),
    }
  }
  outbox(): OutboxItem[] {
    return this.values<OutboxItem>('outbox')
  }
  enqueue(conversationId: number, text: string, whenBusy?: OutboxItem['whenBusy']) {
    const item: OutboxItem = {
      id: crypto.randomUUID(),
      conversationId,
      text,
      whenBusy,
      createdAt: Date.now(),
    }
    this.sql.exec('INSERT INTO outbox (id, value) VALUES (?, ?)', item.id, JSON.stringify(item))
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
        return [this.cursor(), { type: 'outbox', items: this.outbox() }]
      case 'batch':
        this.sql.transaction(() => {
          for (const record of message.conversations) this.put('conversations', record.id, record)
          for (const entry of message.entries) this.put('entries', entry.id, entry)
          for (const doc of message.docs) {
            if (doc.value === null) this.sql.exec('DELETE FROM docs WHERE id=?', doc.id)
            else this.put('docs', doc.id, doc)
          }
        })
        return [{ type: 'ack', batch: message.batch }]
      case 'summaries':
        this.put('metadata', 1, message.value)
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
  visible(id: number): EntryRecord[] {
    const record = this.get('conversations', id) as ConversationRecord | undefined
    const inherited = record?.parent
      ? this.visible(record.parent.conversationId).filter((entry) => entry.id <= record.parent!.at)
      : []
    return [
      ...inherited,
      ...this.values<EntryRecord>('entries').filter((entry) => entry.conversationId === id),
    ].toSorted((a, b) => a.id - b.id)
  }
  view(id: number) {
    const conversation = this.get('conversations', id) as ConversationRecord | undefined
    if (!conversation) return null
    const visible = this.visible(id)
    const marker = visible.findLast((entry) => entry.head !== undefined)
    const entries = marker
      ? [marker, ...visible.filter((entry) => entry.head === undefined && entry.id >= marker.head!)]
      : visible
    const docs: Record<string, JsonObject> = {}
    for (const doc of this.values<ReplicaDoc>('docs'))
      if (
        doc.conversationId === id &&
        doc.kind.startsWith('pi.') &&
        doc.kind !== 'pi.live' &&
        doc.value
      )
        docs[doc.kind] = doc.value
    const queued = [
      ...this.sql.exec<{ submissionId: number; value: string }>(
        'SELECT submissionId, value FROM outbox ORDER BY submissionId',
      ),
    ].flatMap((row) => {
      const item = JSON.parse(row.value) as OutboxItem
      return item.conversationId === id
        ? [{ id: -row.submissionId, mode: item.whenBusy ?? 'followUp', content: item.text }]
        : []
    })
    docs['pi.inbox'] = {
      items: [...(Array.isArray(docs['pi.inbox']?.items) ? docs['pi.inbox'].items : []), ...queued],
    }
    return { conversation, entries, docs }
  }
  history(id: number, before: number) {
    const all = this.visible(id)
      .filter((entry) => entry.id < before)
      .toReversed()
    const entries = all.slice(0, 64)
    return { entries, ...(all.length > 64 ? { before: entries.at(-1)!.id } : {}) }
  }
}

/** Strip edge/browser forwarding metadata before passing the request to Ultimate's loopback admission gate. */
export function proxyRequest(request: Request, origin: string): Request {
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
