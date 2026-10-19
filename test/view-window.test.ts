import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { windowOps, windowView } from '../server/view-window.ts'

const entry = (id: number, head?: number) =>
  ({ id, conversationId: 1, kind: head ? 'pi.compaction' : 'pi.user', head }) as EntryRecord
const view = (entries: EntryRecord[]) =>
  ({ conversation: { id: 1 }, entries, docs: { 'pi.live': {} } }) as unknown as ConversationView
const ids = (value: ConversationView) => value.entries.map((item) => item.id)
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

it('keeps the head marker and the newest entries, and names the oldest kept one', () => {
  const marked = view([entry(100, 5), ...range(5, 20).map((id) => entry(id))])
  const { view: windowed, trimmed } = windowView(marked, 4)
  expect(trimmed).toBe(12)
  expect(ids(windowed)).toEqual([100, 17, 18, 19, 20])
  expect(windowed.older).toBe(17)
  expect(windowed.docs).toBe(marked.docs)
})

it('streams a short view unchanged, with no marker', () => {
  const short = view(range(1, 4).map((id) => entry(id)))
  const { view: windowed, trimmed } = windowView(short, 4)
  expect(windowed).toBe(short)
  expect(trimmed).toBe(0)
  expect('older' in windowed).toBe(false)
})

it('rebases appends so the replica equals the window plus the new entry', () => {
  const full = view(range(1, 10).map((id) => entry(id)))
  const { view: windowed, trimmed } = windowView(full, 3)
  const ops: Op[] = [
    ['s', ['docs', 'pi.live', 'run'], { taskId: 1 }],
    ['p', ['entries'], 10, 0, [entry(11) as never]],
  ]
  const rebased = windowOps(ops, trimmed)!
  expect(rebased[0]).toBe(ops[0])
  const replica = applyImmutable(windowed, rebased)
  expect(ids(replica)).toEqual([8, 9, 10, 11])
  expect(replica.docs['pi.live']).toEqual({ run: { taskId: 1 } })
  expect(windowOps(ops, 0)).toBe(ops)
})

it('asks for a fresh window on a head marker or a replaced view', () => {
  const marker: Op = ['p', ['entries'], 0, 6, [entry(20, 7) as never]]
  expect(windowOps([marker], 7)).toBeUndefined()
  expect(windowOps([['r', {}]], 7)).toBeUndefined()
  // Without a window a head marker passes through: the replica holds every entry it trims.
  expect(windowOps([marker], 0)).toEqual([marker])
})
