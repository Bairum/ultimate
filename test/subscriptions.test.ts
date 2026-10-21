import { expect, it } from 'vitest'
import { exitState, fireText, trimLog } from '../extensions/subscriptions/types.ts'

it('accepts loose FIRE text, including JSON and an empty payload, only on stdout', () => {
  expect(fireText('FIRE done', true)).toBe('done')
  expect(fireText('FIRE {"status":"ok"}', true)).toBe('{"status":"ok"}')
  expect(fireText('FIRE', true)).toBe('')
  expect(fireText('FIRE\tfinished', true)).toBe('finished')
  for (const text of ['progress', 'FIREWORKS', ' FIRE done', 'fire done'])
    expect(fireText(text, true)).toBeUndefined()
  expect(fireText('FIRE not a notification', false)).toBeUndefined()
})

it('finishes only fired one-shots; every recurring exit and unsuccessful one-shot investigates', () => {
  expect(exitState(true, 1, 0, false)).toBe('done')
  expect(exitState(true, 1, null, true)).toBe('done')
  expect(exitState(true, 0, 0, false)).toBe('investigating')
  expect(exitState(true, 0, 3, false)).toBe('investigating')
  expect(exitState(true, 1, 3, true)).toBe('investigating')
  expect(exitState(true, 1, null, false)).toBe('investigating')
  expect(exitState(false, 2, 0, false)).toBe('investigating')
  expect(exitState(false, 2, 3, false)).toBe('investigating')
  // Starting another run resets its fire count; an earlier lifetime fire cannot hide a failed restart.
  expect(exitState(true, 0, 0, true)).toBe('investigating')
})

it('retains the newest output within both line and byte limits', () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join('')
  const trimmed = trimLog(text)
  expect(trimmed.split('\n')).toHaveLength(2001)
  expect(trimmed.startsWith('line 1000\n')).toBe(true)
  expect(trimmed.endsWith('line 2999\n')).toBe(true)
  const long = trimLog('x'.repeat(300 * 1024) + '\nend\n')
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(256 * 1024)
  expect(long.endsWith('\nend\n')).toBe(true)
  expect(trimLog('progress\n')).toBe('progress\n')
})
