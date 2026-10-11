export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type TokenCounters = Rates & { id: number }
export type RateSample = { rates: Rates; elapsed: number }
const keys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
const zero = (): Rates => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
export const samplingGap = 5000
const windowMs = 30000

/** Numeric observations only; signed partial corrections remain in the rolling sum. */
export function createRateSampler() {
  let members = new Map<number, TokenCounters>()
  let points: { at: number; total: Rates }[] = []
  return (at: number, counters: TokenCounters[]): RateSample | null => {
    const previous = points.at(-1)
    if (!previous || at < previous.at || at - previous.at > samplingGap) {
      members = new Map(counters.map((counter) => [counter.id, { ...counter }]))
      points = [{ at, total: zero() }]
      return null
    }
    // Do not consume counters without elapsed time; the next observation keeps that delta.
    if (at === previous.at) return null
    const total = { ...previous.total }
    for (const counter of counters) {
      const before = members.get(counter.id)
      if (before) for (const key of keys) total[key] += counter[key] - before[key]
    }
    members = new Map(counters.map((counter) => [counter.id, { ...counter }]))
    points.push({ at, total })
    const cutoff = at - windowMs
    while (points.length > 2 && points[1].at <= cutoff) points.shift()
    const first = points[0]
    const next = points[1]
    const start = Math.max(first.at, cutoff)
    const fraction = (start - first.at) / (next.at - first.at)
    const elapsed = (at - start) / 1000
    const rates = zero()
    for (const key of keys) {
      const baseline = first.total[key] + (next.total[key] - first.total[key]) * fraction
      rates[key] = Math.max(0, (total[key] - baseline) / elapsed)
    }
    return { rates, elapsed }
  }
}
