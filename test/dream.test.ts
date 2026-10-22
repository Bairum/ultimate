import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { Tx } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import {
  busyElsewhere,
  decide,
  fileJournal,
  journalText,
  landed,
  reportPass,
  Sessions,
  startSession,
  toolStats,
} from '../extensions/dream/server.ts'
import { temp } from './helpers.ts'

/** A transaction over plain documents, keyed by kind and conversation. */
function fakeTx() {
  const docs = new Map<string, object>()
  return {
    doc: async (
      { definition: def }: { definition: { kind: string; initial: () => object } },
      id: number,
    ) => {
      const key = `${def.kind}:${id}`
      if (!docs.has(key)) docs.set(key, def.initial())
      return docs.get(key)
    },
  } as unknown as Tx
}
const session = async (tx: Tx, id = 1) =>
  (await tx.doc(Sessions, 1 as never)).sessions.find((item) => item.id === id)!

const journal = {
  session: 1,
  learned: ['I learned to read the trace.', 'I keep editing stale text.', "I'd like a diff tool."],
  text: '## Memory\nNothing stale.',
  proposals: [
    {
      id: 'fast-default',
      pass: 'codify',
      title: 'Default fast for Sol',
      size: 'S',
      retire: 'sol-runs-fast',
    },
    { id: 'drop-stale', pass: 'memory', title: 'Delete memory demo' },
  ],
}

it('lets one session run at a time, with every pass waiting', async () => {
  const tx = fakeTx()
  expect(await startSession(tx, 10)).toBe(1)
  expect((await session(tx)).passes).toEqual({
    memory: { status: 'waiting' },
    failures: { status: 'waiting' },
    tools: { status: 'waiting' },
    corrections: { status: 'waiting' },
    codify: { status: 'waiting' },
  })
  await expect(startSession(tx, 11)).rejects.toThrow('Dream session 1 is still open')
})

it('names the first pass reporter the dreamer and refuses unknown passes', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await reportPass(tx, { session: 1, pass: 'tools', status: 'running' }, 40)
  await reportPass(tx, { session: 1, pass: 'tools', status: 'done', note: '12 unused' }, 41)
  const found = await session(tx)
  expect(found.dreamer).toBe(40)
  expect(found.passes.tools).toEqual({ status: 'done', note: '12 unused' })
  await expect(reportPass(tx, { session: 1, pass: 'dreams', status: 'done' }, 40)).rejects.toThrow(
    'pass must be one of',
  )
  await expect(reportPass(tx, { session: 2, pass: 'tools', status: 'done' }, 40)).rejects.toThrow(
    'No dream session 2',
  )
})

it('files the journal once, validating its three lines and proposal ids', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await expect(fileJournal(tx, { ...journal, learned: ['one'] }, 2)).rejects.toThrow('3 lines')
  await expect(
    fileJournal(tx, { ...journal, proposals: [journal.proposals[0], journal.proposals[0]] }, 2),
  ).rejects.toThrow('unique slug')
  const found = await fileJournal(tx, journal, 2)
  expect(found.proposals.map((item) => [item.id, item.status, item.retire])).toEqual([
    ['fast-default', 'open', 'sol-runs-fast'],
    ['drop-stale', 'open', undefined],
  ])
  // A second filing (a retried action) keeps the first.
  await fileJournal(tx, { ...journal, text: 'other' }, 3)
  expect((await session(tx)).journal?.text).toBe(journal.text)
  expect(journalText(await session(tx))).toContain(
    '- fast-default [codify] (S): Default fast for Sol — retires memory sol-runs-fast once landed',
  )
})

it('follows approved proposals to landing and ends the session when all are settled', async () => {
  const tx = fakeTx()
  await startSession(tx, 1)
  await fileJournal(tx, journal, 2)
  await expect(
    decide(tx, { session: 1, proposal: 'fast-default', status: 'approved' }, 3),
  ).rejects.toThrow('branch must be a positive integer')
  await decide(tx, { session: 1, proposal: 'fast-default', status: 'approved', branch: 77 }, 3)
  await decide(tx, { session: 1, proposal: 'drop-stale', status: 'applied' }, 4)
  expect((await session(tx)).endedAt).toBeUndefined()
  await landed(tx, 99, 'abc', 5)
  expect((await session(tx)).proposals[0].status).toBe('approved')
  await landed(tx, 77, 'def', 6)
  const found = await session(tx)
  expect(found.proposals[0]).toMatchObject({ status: 'landed', sha: 'def' })
  expect(found.endedAt).toBe(6)
  await expect(reportPass(tx, { session: 1, pass: 'tools', status: 'done' }, 1)).rejects.toThrow(
    'has ended',
  )
  expect(await startSession(tx, 7)).toBe(2)
})

it('counts top-level conversations at work besides @ultimate', () => {
  expect(
    busyElsewhere(
      [
        { id: 5, busy: true, title: '@ultimate' },
        { id: 8, busy: true, title: 'Fix it' },
        { id: 9, busy: true, parentConversationId: 8 },
        { id: 10, busy: false, title: 'Idle' },
      ],
      5,
    ),
  ).toEqual([{ id: 8, title: 'Fix it' }])
})

it('reads tool numbers from the trace, with unused tools and frequent errors', async () => {
  const file = join(await temp(), 'trace.sqlite')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE calls (id TEXT, at REAL, ms REAL, kind TEXT, name TEXT, ok INTEGER, error TEXT)',
  )
  const insert = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?)')
  insert.run('1', 100, 10, 'tool', 'edit', 1, null)
  insert.run('2', 200, 30, 'tool', 'edit', 0, 'Could not find the exact text')
  insert.run('3', 300, 5, 'tool', 'read', 1, null)
  insert.run('4', 50, 5, 'action', 'dream/stats', 1, null)
  db.close()
  expect(toolStats(file, ['edit', 'read', 'notify'])).toEqual({
    since: 100,
    calls: 3,
    tools: [
      { name: 'edit', calls: 2, failed: 1, avgMs: 20 },
      { name: 'read', calls: 1, failed: 0, avgMs: 5 },
    ],
    unused: ['notify'],
    errors: [{ name: 'edit', error: 'Could not find the exact text', count: 1 }],
  })
  expect(toolStats(join(await temp(), 'none.sqlite'), ['read']).unused).toEqual(['read'])
})
