import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { reachedFork } from '../../web/src/app/fork.ts'

const row = (id: number, conversationId: number, kind = 'pi.user') =>
  ({ id, conversationId, kind, createdAt: 0 }) as unknown as EntryRecord

it('keeps paging a long fork until its oldest own entry and the inherited one before it are loaded', () => {
  // Fork #9 of #1 at entry 50; it has 300 own entries from 100. The window keeps a compaction marker its source wrote
  // (id 40) next to only its newest 150 entries.
  const own = Array.from({ length: 300 }, (_, index) => row(100 + index, 9))
  const marker = row(40, 1, 'pi.compaction')
  const window = [marker, ...own.slice(150)]
  expect(reachedFork(window, 9, marker.id)).toBe(false)
  expect(reachedFork([marker, ...own], 9, marker.id)).toBe(false)
  expect(reachedFork([marker, row(50, 1), ...own], 9, marker.id)).toBe(true)
})

it('never stops a conversation that is not a fork', () => {
  expect(reachedFork([row(1, 9), row(2, 9)], 9)).toBe(false)
  expect(reachedFork([], 9)).toBe(false)
})
