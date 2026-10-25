import { expect, it } from 'vitest'
import { Runs, pruneRuns } from '../extensions/advisor/state.ts'
import { initialSignals, signals } from '../extensions/advisor/signals.ts'
import type { EntryRecord } from '@earendil-works/pi-durable'

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
