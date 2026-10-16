import { expect, it } from 'vitest'
import type { OverviewRow } from '../../extensions/conversations/types.ts'
import { cueOf, listener, settle } from '../../extensions/sounds/cues.ts'

const answered = (answerId: number, extra: Partial<OverviewRow> = {}): OverviewRow => ({
  runState: 'answered',
  inputId: answerId - 1,
  answerId,
  ...extra,
})
const assessed = (answerId: number, value: 'needs_input' | 'done' | 'neutral') =>
  answered(answerId, {
    assessmentStatus: 'ready',
    assessment: { inputId: answerId - 1, answerId, value } as never,
  })

it('tells a question, a finished task and a failed run apart', () => {
  expect(cueOf('7', assessed(10, 'needs_input'))).toEqual({
    key: '7:10',
    sound: 'input',
    settled: true,
  })
  expect(cueOf('7', assessed(10, 'done'))?.sound).toBe('finished')
  expect(cueOf('7', assessed(10, 'neutral'))?.sound).toBe('finished')
  expect(cueOf('7', { runState: 'error', inputId: 4 })).toEqual({
    key: '7:4',
    sound: 'failed',
    settled: true,
  })
  expect(cueOf('7', answered(10, { assessmentStatus: 'error' }))?.settled).toBe(true)
})

it('stays quiet while working and while the assessment is in flight', () => {
  expect(cueOf('7', { runState: 'working', inputId: 9 })).toBeUndefined()
  expect(cueOf('7', { runState: 'queued' })).toBeUndefined()
  expect(cueOf('7', answered(10, { assessmentStatus: 'pending' }))).toBeUndefined()
  // A stale status from the previous reply: no assessment of this one is known yet.
  expect(cueOf('7', answered(10, { assessmentStatus: 'ready' }))?.settled).toBe(false)
})

it('takes what is there at first as heard, and sounds later news once', () => {
  const hear = listener()
  const top = new Set([1, 2])
  expect(hear({ 1: assessed(10, 'done') }, top, 0).due).toEqual([])
  expect(hear({ 1: assessed(10, 'done') }, top, 1).due).toEqual([])
  const news = { 1: assessed(10, 'done'), 2: assessed(20, 'needs_input') }
  expect(hear(news, top, 2).due.map((cue) => cue.sound)).toEqual(['input'])
  expect(hear(news, top, 3).due).toEqual([])
  expect(hear({ ...news, 1: { runState: 'error', inputId: 30 } }, top, 4).due).toEqual([
    { key: '1:30', sound: 'failed', settled: true },
  ])
})

it('leaves subagents and landers out', () => {
  const hear = listener()
  hear({}, new Set([1]), 0)
  expect(hear({ 5: assessed(10, 'done') }, new Set([1]), 1).due).toEqual([])
})

it('waits for a reply to settle, and lets a starting assessment decide', () => {
  const hear = listener()
  const top = new Set([1])
  hear({}, top, 0)
  expect(hear({ 1: answered(10) }, top, 100)).toEqual({ due: [], waiting: true })
  expect(hear({ 1: answered(10) }, top, 100 + settle).due.map((cue) => cue.sound)).toEqual([
    'finished',
  ])

  hear({ 1: answered(20) }, top, 10_000)
  expect(hear({ 1: answered(20, { assessmentStatus: 'pending' }) }, top, 10_100)).toEqual({
    due: [],
    waiting: false,
  })
  expect(hear({ 1: assessed(20, 'needs_input') }, top, 20_000).due.map((cue) => cue.sound)).toEqual(
    ['input'],
  )
})
