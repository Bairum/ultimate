import { describe, expect, it } from 'vitest'
import { createRateSampler, type TokenCounters } from '../../extensions/status-line/rates.tsx'

const counter = (id: number, output: number): TokenCounters => ({
  id,
  output,
  input: output * 2,
  cacheRead: output * 3,
  cacheWrite: output * 4,
})

describe('status-line rolling model rates', () => {
  it('baselines history and adds parallel members with one wall-clock denominator', () => {
    const sample = createRateSampler()
    expect(sample(0, [counter(1, 1000), counter(2, 2000)])).toBeNull()
    expect(sample(2000, [counter(1, 1100), counter(2, 2300)])).toEqual({
      elapsed: 2,
      rates: { input: 400, output: 200, cacheRead: 600, cacheWrite: 800 },
    })
    // A newly discovered child's existing tokens are never attributed to this window.
    expect(
      sample(3000, [counter(1, 1100), counter(2, 2300), counter(3, 9000)])?.rates.output,
    ).toBeCloseTo(400 / 3)
    expect(sample(4000, [counter(1, 1100), counter(2, 2300), counter(3, 9100)])?.rates.output).toBe(
      125,
    )
  })

  it('keeps signed partial corrections and does not count partial-to-final settlement twice', () => {
    const sample = createRateSampler()
    sample(0, [counter(1, 100)])
    sample(1000, [counter(1, 200)]) // settled 100 + partial 100
    expect(sample(2000, [counter(1, 180)])?.rates.output).toBe(40) // corrected partial 80
    expect(sample(3000, [counter(1, 180)])?.rates.output).toBeCloseTo(80 / 3) // settled 180, no partial
    expect(sample(4000, [counter(1, 90)])?.rates.output).toBe(0) // clamp display only
    expect(sample(5000, [counter(1, 110)])?.rates.output).toBe(2) // not 20: the negative delta survived
  })

  it('decays while idle, bounds the window to 30s and interpolates its sampled edge', () => {
    const sample = createRateSampler()
    sample(0, [counter(1, 0)])
    expect(sample(2000, [counter(1, 100)])?.rates.output).toBe(50)
    for (let at = 4000; at <= 30000; at += 2000) sample(at, [counter(1, 100)])
    expect(sample(31000, [counter(1, 100)])).toEqual({
      elapsed: 30,
      rates: { input: 100 / 30, output: 50 / 30, cacheRead: 150 / 30, cacheWrite: 200 / 30 },
    })
    expect(sample(32000, [counter(1, 100)])?.rates.output).toBe(0)
  })

  it('never fabricates a rate at zero time and rebaselines after long gaps or clock reversal', () => {
    const sample = createRateSampler()
    expect(sample(1000, [counter(1, 10)])).toBeNull()
    expect(sample(1000, [counter(1, 20)])).toBeNull()
    expect(sample(2000, [counter(1, 20)])?.rates.output).toBe(10)
    expect(sample(8000, [counter(1, 10000)])).toBeNull()
    expect(sample(9000, [counter(1, 10010)])?.rates.output).toBe(10)
    expect(sample(0, [counter(1, 0)])).toBeNull()
  })

  it('rebaselines a member that disappears and returns', () => {
    const sample = createRateSampler()
    sample(0, [counter(1, 0), counter(2, 0)])
    sample(1000, [counter(1, 10)])
    expect(sample(2000, [counter(1, 20), counter(2, 1000)])?.rates.output).toBe(10)
  })
})
