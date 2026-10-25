import { expect, it } from 'vitest'
import { Runs, State, pruneRuns } from '../extensions/advisor/state.ts'
import { initialSignals, signals } from '../extensions/advisor/signals.ts'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { stats } from '../extensions/advisor/tracking.ts'

it('drops concluded rows and operational settlements older than 24 hours', () => {
  const now = 2 * 86_400_000
  const runs = Runs.definition.initial()
  runs.conversations['2'] = { rounds: 0, signals: [], deliveries: ['recent'] }
  runs.conversations['3'] = { rounds: 0, signals: [] }
  runs.settled = ['old', 'recent']
  runs.settledAt = { old: now - 86_400_001, recent: now }
  runs.deliveries.old = { review: 'old' } as never
  runs.deliveries.recent = { review: 'recent' } as never
  pruneRuns(runs, new Set([2]), now)
  expect(runs.conversations['2']).toBeUndefined()
  expect(runs.conversations['3']).toBeDefined()
  expect(runs.settled).toEqual(['recent'])
  expect(runs.settledAt).toEqual({ recent: now })
  expect(runs.deliveries).toEqual({})
})
it('carries deterministic signal counts across rounds without reprocessing earlier entries', () => {
  const state = initialSignals()
  const round = (id: number) =>
    ({
      id,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: `c${id}`, name: 'read', arguments: { path: 'same.ts' } },
          ],
        },
      ],
    }) as unknown as EntryRecord
  expect(signals([round(1)], '/checkout', '', state)).toEqual([])
  expect(signals([round(1), round(2)], '/checkout', '', state)).toEqual([])
  expect(signals([round(3)], '/checkout', '', state)).toContain('repeated tool call')
  expect(state.rounds).toBe(3)
  expect(state.cursor).toBe(3)
})

it('counts retained lifecycle outcomes per role and excludes cards from delivery/pending totals', () => {
  const state = State.definition.initial()
  const base = {
    id: 'n',
    ref: '00001',
    conversation: 2,
    advisor: 'verification',
    role: 'worker' as const,
    point: 'answer' as const,
    severity: 'concern' as const,
    note: 'check',
    evidence: '#1',
    at: 10,
    status: 'resolved' as const,
    delivered: 'note' as const,
  }
  state.notes = [
    {
      ...base,
      readAt: 11,
      response: { status: 'addressed', source: 'ack', at: 12 },
      archivedAt: 13,
    },
    {
      ...base,
      id: 'deferred',
      readAt: 11,
      response: { status: 'deferred', source: 'ack', at: 12 },
    },
    {
      ...base,
      id: 'disputed',
      readAt: 11,
      response: { status: 'disputed', source: 'judged', at: 12 },
    },
    { ...base, id: 'ignored', readAt: 11, response: { status: 'ignored', source: 'auto', at: 12 } },
    { ...base, id: 'pending', status: 'open' },
    { ...base, id: 'card', delivered: 'card' },
    { ...base, id: 'dismissed', status: 'dismissed', closedBy: 'user' },
    { ...base, id: 'old', at: 0 },
  ]
  expect(stats(state, 5)).toEqual({
    since: 5,
    roles: {
      worker: {
        delivered: 6,
        read: 4,
        addressed: 1,
        deferred: 1,
        disputed: 1,
        ignored: 1,
        unread: 0,
        late: 0,
        dismissed: 1,
        pending: 2,
      },
    },
  })
})
