import { expect, it } from 'vitest'
import { pinnedOf, progress } from '../../extensions/dream/types.ts'
import type { Proposal, Session } from '../../extensions/dream/refs.ts'

const waiting = { status: 'waiting' } as const
const session = (id: number, fields: Partial<Session> = {}): Session => ({
  id,
  startedAt: 0,
  passes: {
    memory: { status: 'done' },
    failures: { status: 'running' },
    tools: waiting,
    corrections: waiting,
    codify: waiting,
  },
  proposals: [],
  ...fields,
})
const journal = { learned: [], text: '', at: 1 }
const proposals = (...statuses: Proposal['status'][]) =>
  statuses.map((status, index) => ({
    id: String(index),
    pass: 'memory' as const,
    title: 't',
    status,
  }))

it('pins the open session, whether or not its journal is filed', () => {
  expect(pinnedOf([])).toBeUndefined()
  expect(
    pinnedOf([
      session(1, { endedAt: 2, journal, sleep: { chapter: 'a', phase: 'asleep', at: 3 } }),
      session(2),
    ])?.id,
  ).toBe(2)
  expect(pinnedOf([session(1, { journal, proposals: proposals('open') })])?.id).toBe(1)
})

it('keeps a settled session pinned until it falls asleep', () => {
  const settled = session(1, { journal, endedAt: 2, proposals: proposals('landed', 'rejected') })
  expect(pinnedOf([settled])?.id).toBe(1)
  expect(
    pinnedOf([{ ...settled, sleep: { chapter: 'a', phase: 'asleep', at: 3 } }]),
  ).toBeUndefined()
})

it('drops a session ended early, one that stays in its chapter, and one that never filed a journal', () => {
  expect(
    pinnedOf([session(1, { journal, endedAt: 2, proposals: proposals('open') })]),
  ).toBeUndefined()
  expect(pinnedOf([session(1, { endedAt: 2 })])).toBeUndefined()
  const stay = {
    automation: 'A1',
    name: 'Dream before compaction',
    at: 0,
    outcome: { changes: 1, threshold: 5, result: 'stay' as const, at: 3 },
  }
  expect(pinnedOf([session(1, { journal, endedAt: 2, beforeCompaction: stay })])).toBeUndefined()
})

it('says where the session stands', () => {
  expect(progress(session(1))).toEqual({ long: 'dreaming', moons: true })
  expect(
    progress(
      session(1, {
        journal,
        proposals: proposals('landed', 'applied', 'rejected', 'approved', 'approved', 'open'),
      }),
    ),
  ).toEqual({ long: '3 of 6 settled · 1 to decide · 2 on branches', short: '3/6' })
  expect(progress(session(1, { journal, endedAt: 2, proposals: proposals('landed') }))).toEqual({
    long: 'ready to fall asleep',
  })
  expect(
    progress(session(1, { journal, endedAt: 2, sleep: { chapter: 'a', phase: 'seeding', at: 3 } })),
  ).toEqual({ long: 'falling asleep' })
})
