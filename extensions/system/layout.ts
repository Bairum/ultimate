/** The Agent Lanes geometry: where a window's ticks and a run's block sit, as fractions of the timeline's width. */
import type { LaneCall, LaneRun } from './refs.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The windows the user picks from, with the step between their ticks. */
export const windows = {
  '30m': { ms: 30 * MINUTE, step: 5 * MINUTE },
  '2h': { ms: 2 * HOUR, step: 20 * MINUTE },
  '24h': { ms: 24 * HOUR, step: 4 * HOUR },
} as const
export type WindowName = keyof typeof windows

/** `-25m`, `-1h`, `-1h20m`: how long before now. */
export function ago(ms: number) {
  const minutes = Math.round(ms / MINUTE)
  if (minutes < 60) return `-${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `-${hours}h${minutes % 60}m` : `-${hours}h`
}

/** The ticks of a window ending now, oldest first, each at `at` (0 the window's start, 1 now); the last is now. */
export function ticks(window: WindowName) {
  const { ms, step } = windows[window]
  const found: { at: number; label: string }[] = []
  for (let before = ms - step; before > 0; before -= step)
    found.push({ at: 1 - before / ms, label: ago(before) })
  found.push({ at: 1, label: 'now' })
  return found
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/** Where time `at` (epoch ms) falls in the window `[since, now]`, clamped to it. */
export const position = (at: number, since: number, now: number) =>
  clamp((at - since) / (now - since))

/**
 * A run's block in the window `[since, now]`: `left` and `width` as fractions; an open run reaches now. Undefined when
 * the run lies wholly outside the window.
 */
export function block(run: LaneRun, since: number, now: number) {
  const start = Date.parse(run.start)
  const end = run.end === undefined ? now : Date.parse(run.end)
  if (end < since || start > now) return undefined
  const left = position(start, since, now)
  return { left, width: position(end, since, now) - left }
}

/**
 * A block's label: the tool at least half of its tool calls are (model calls between them do not count), else how
 * many calls it has.
 */
export function label(calls: readonly LaneCall[], more = 0) {
  const counts = new Map<string, number>()
  let tools = 0
  for (const call of calls)
    if (call.kind === 'tool') {
      tools++
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
    }
  const [top] = [...counts].toSorted((a, b) => b[1] - a[1])
  if (top && top[1] * 2 >= tools) return top[0]
  const total = calls.length + more
  return total === 1 ? calls[0].name : `${total} calls`
}

/** A run's length in milliseconds, up to now while it is open. */
export const duration = (run: LaneRun, now: number) =>
  (run.end === undefined ? now : Date.parse(run.end)) - Date.parse(run.start)
