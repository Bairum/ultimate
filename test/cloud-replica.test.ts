import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationRecord, EntryRecord } from '@earendil-works/pi-durable'
import { ReplicaStore, proxyRequest } from '../cloud/replica.ts'
import type { Sql } from '../cloud/replica.ts'
import type { MachineMessage, ReplicaDoc } from '../cloud/protocol.ts'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function replica() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const sql: Sql = {
    exec: <T extends Record<string, unknown>>(
      query: string,
      ...bindings: (string | number | null)[]
    ) => {
      const statement = db.prepare(query)
      if (statement.columns().length) return statement.all(...bindings) as T[]
      statement.run(...bindings)
      return []
    },
    transaction: (run) => {
      db.exec('BEGIN')
      try {
        const result = run()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return new ReplicaStore(sql)
}
const conversation = (id: number, parent?: { conversationId: number; at: number }) =>
  ({ id, ...(parent ? { parent } : {}) }) as ConversationRecord
const entry = (id: number, conversationId = 1, head?: number) =>
  ({
    id: id as EntryRecord['id'],
    conversationId: conversationId as EntryRecord['conversationId'],
    kind: 'pi.user',
    data: { text: `entry ${id}` },
    ...(head !== undefined ? { head: head as EntryRecord['head'] } : {}),
  }) as EntryRecord
const doc = (id: number, kind = 'pi.agent'): ReplicaDoc => ({
  id,
  kind,
  conversationId: 1,
  value: { test: true },
  hash: `hash-${id}`,
})
function batch(
  store: ReplicaStore,
  entries: EntryRecord[] = [],
  docs: ReplicaDoc[] = [],
  conversations = [conversation(1)],
) {
  const message: MachineMessage = { type: 'batch', batch: 1, conversations, entries, docs }
  return store.receive(message)
}

describe('cloud replica', () => {
  it('applies a batch twice idempotently, returns its ack and cursor hashes, and retires docs', () => {
    const store = replica()
    batch(store, [entry(1), entry(2)], [doc(3)])
    expect(batch(store, [entry(1), entry(2)], [doc(3)])).toEqual([{ type: 'ack', batch: 1 }])
    expect(store.view(1)?.entries.map((record) => record.id)).toEqual([1, 2])
    expect(store.receive({ type: 'hello', machine: 'test', build: 'test' })).toEqual([
      { type: 'cursor', maxEntryId: 2, docs: { 3: 'hash-3' } },
      { type: 'outbox', items: [] },
    ])
    batch(store, [], [{ ...doc(3), value: null }])
    expect(store.cursor().docs).toEqual({})
    expect(store.view(1)?.docs['pi.agent']).toBeUndefined()
  })
  it('rolls a failing batch back atomically', () => {
    const store = replica()
    batch(store, [entry(1)])
    const bad = { ...entry(3), data: 1n } as unknown as EntryRecord
    expect(() => batch(store, [entry(2), bad])).toThrow(/BigInt/)
    expect(store.cursor().maxEntryId).toBe(1)
  })
  it('reconstructs plain views, drops live docs and keeps extension docs outside the view', () => {
    const store = replica()
    batch(store, [entry(1), entry(2)], [doc(1), doc(2, 'pi.live'), doc(3, 'ultimate.ui')])
    expect(store.view(1)).toEqual({
      conversation: { id: 1 },
      entries: [entry(1), entry(2)],
      docs: { 'pi.agent': { test: true }, 'pi.inbox': { items: [] } },
    })
    expect(store.doc(1, 'ultimate.ui')).toEqual({ test: true })
    expect(store.view(99)).toBeNull()
  })
  it('uses the latest head marker and active non-head entries', () => {
    const store = replica()
    batch(store, [entry(1), entry(2, 1, 1), entry(3), entry(4, 1, 3), entry(5)])
    expect(store.view(1)?.entries.map((record) => record.id)).toEqual([4, 3, 5])
  })
  it('inherits recursively only through each fork point, not later parent entries', () => {
    const store = replica()
    batch(
      store,
      [entry(1), entry(2), entry(3, 2), entry(4), entry(5, 2), entry(6, 3)],
      [],
      [
        conversation(1),
        conversation(2, { conversationId: 1, at: 2 }),
        conversation(3, { conversationId: 2, at: 3 }),
      ],
    )
    expect(store.view(2)?.entries.map((record) => record.id)).toEqual([1, 2, 3, 5])
    expect(store.view(3)?.entries.map((record) => record.id)).toEqual([1, 2, 3, 6])
  })
  it('pages history newest first across the 64 boundary', () => {
    const store = replica()
    batch(
      store,
      Array.from({ length: 130 }, (_, index) => entry(index + 1)),
    )
    const first = store.history(1, 131)
    expect(first.entries).toHaveLength(64)
    expect(first.entries[0].id).toBe(130)
    expect(first.before).toBe(67)
    const second = store.history(1, first.before!)
    expect(second.before).toBe(3)
    expect(store.history(1, second.before!)).toEqual({ entries: [entry(2), entry(1)] })
  })
  it('keeps an outbox, exposes numeric queue IDs in pi.inbox, and deletes only on delivery', () => {
    const store = replica()
    batch(
      store,
      [],
      [
        {
          ...doc(1, 'pi.inbox'),
          value: { items: [{ id: 10, mode: 'steer', content: 'already queued' }] },
        },
      ],
    )
    const { item, submissionId } = store.enqueue(1, 'offline prompt', 'steer')
    expect(submissionId).toBeLessThan(0)
    expect(store.outbox()).toEqual([item])
    expect(store.view(1)?.docs['pi.inbox']).toEqual({
      items: [
        { id: 10, mode: 'steer', content: 'already queued' },
        { id: submissionId, mode: 'steer', content: 'offline prompt' },
      ],
    })
    expect(store.receive({ type: 'hello', machine: 'test', build: 'test' })[1]).toEqual({
      type: 'outbox',
      items: [item],
    })
    store.receive({ type: 'delivered', id: item.id, submissionId: 12 })
    store.receive({ type: 'delivered', id: item.id, submissionId: 12 })
    expect(store.outbox()).toEqual([])
    expect(store.view(1)?.docs['pi.inbox'].items).toHaveLength(1)
  })
  it('stores the latest metadata', () => {
    const store = replica()
    store.receive({ type: 'models', value: { models: [] } })
    store.receive({ type: 'models', value: { models: ['updated'] } })
    expect(store.metadata(3)).toEqual({ models: ['updated'] })
  })
  it('rewrites proxy admission headers and preserves method, query and body', async () => {
    const request = new Request('https://cloud.example/api/extensions/test/actions/run?x=1', {
      method: 'POST',
      headers: {
        Origin: 'https://cloud.example',
        'CF-Connecting-IP': '1.2.3.4',
        Forwarded: 'for=1.2.3.4',
        'X-Forwarded-Host': 'cloud.example',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: '{"args":1}',
    })
    const proxied = proxyRequest(request, 'http://127.0.0.1:4800')
    expect(proxied.url).toBe('http://127.0.0.1:4800/api/extensions/test/actions/run?x=1')
    expect(proxied.headers.get('Host')).toBe('127.0.0.1:4800')
    expect(proxied.headers.get('Origin')).toBe('http://127.0.0.1:4800')
    expect([...proxied.headers.keys()]).toEqual(['content-type', 'host', 'origin'])
    expect(proxied.method).toBe('POST')
    expect(await proxied.text()).toBe('{"args":1}')
  })
})
