import { expect, it } from 'vitest'
import { ago, block, duration, label, position, ticks } from '../../extensions/system/layout.ts'
import type { LaneCall, LaneRun } from '../../extensions/system/refs.ts'

const now = Date.parse('2026-10-19T12:00:00Z')
const since = now - 30 * 60_000
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
const call = (name: string, kind = 'tool', ok = true): LaneCall => ({
  at: at(1),
  ms: 100,
  kind,
  name,
  ok,
  trace: 't',
})
const run = (start: number, end?: number): LaneRun => ({
  start: at(start),
  ...(end === undefined ? {} : { end: at(end) }),
  ok: true,
  calls: [],
})

it('ticks a window every step, oldest first, ending at now', () => {
  const thirty = ticks('30m')
  expect(thirty.map((tick) => tick.label)).toEqual(['-25m', '-20m', '-15m', '-10m', '-5m', 'now'])
  thirty.forEach((tick, index) => expect(tick.at).toBeCloseTo((index + 1) / 6))
  expect(thirty.at(-1)!.at).toBe(1)
  expect(ticks('2h').map((tick) => tick.label)).toEqual([
    '-1h40m',
    '-1h20m',
    '-1h',
    '-40m',
    '-20m',
    'now',
  ])
  expect(ticks('24h').map((tick) => tick.label)).toEqual([
    '-20h',
    '-16h',
    '-12h',
    '-8h',
    '-4h',
    'now',
  ])
  expect(ago(90 * 60_000)).toBe('-1h30m')
})

it('places a finished run by its start and end, and an open one up to now', () => {
  const finished = block(run(15, 12), since, now)!
  expect(finished.left).toBeCloseTo(0.5)
  expect(finished.width).toBeCloseTo(0.1)
  const open = block(run(3), since, now)!
  expect(open.left).toBeCloseTo(0.9)
  expect(open.left + open.width).toBeCloseTo(1)
})

it('clips a run crossing the window start and drops one wholly before it', () => {
  const crossing = block(run(40, 27), since, now)!
  expect(crossing.left).toBe(0)
  expect(crossing.width).toBeCloseTo(0.1)
  expect(block(run(50, 35), since, now)).toBeUndefined()
  expect(position(now + 60_000, since, now)).toBe(1)
})

it('labels a block by its main tool, ignoring model calls, else by its call count', () => {
  const model = call('anthropic/opus', 'model')
  expect(label([model, call('bash'), model, call('bash'), model, call('read')])).toBe('bash')
  expect(label([call('read'), call('edit'), call('bash')])).toBe('3 calls')
  expect(label([call('read'), call('edit'), call('bash')], 4)).toBe('7 calls')
  expect(label([model])).toBe('anthropic/opus')
  expect(label([model, model])).toBe('2 calls')
})

it('measures an open run up to now', () => {
  expect(duration(run(15, 12), now)).toBe(3 * 60_000)
  expect(duration(run(2), now)).toBe(2 * 60_000)
})
