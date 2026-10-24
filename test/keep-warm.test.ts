import { expect, it } from 'vitest'
import { due, IDLE_STOP, LEAD, TTL } from '../extensions/keep-warm/due.ts'
import * as keepWarm from '../extensions/keep-warm/server.ts'

const now = Date.parse('2026-10-24T12:00:00Z')
const minutes = (count: number) => count * 60_000

it('pings in the last minutes of the cache hour while the user was here recently', () => {
  expect(due({ now, lastRequest: now - LEAD, inputAt: now - minutes(70) })).toBe(true)
  expect(due({ now, lastRequest: now - minutes(59), inputAt: now - minutes(59) })).toBe(true)
})

it('waits while the cache is fresh and never pings a cold one', () => {
  expect(due({ now, lastRequest: now - minutes(30), inputAt: now - minutes(30) })).toBe(false)
  expect(due({ now, lastRequest: now - TTL, inputAt: now - minutes(61) })).toBe(false)
})

it('stops once the user has been away 8 hours, and without any input', () => {
  expect(due({ now, lastRequest: now - LEAD, inputAt: now - IDLE_STOP })).toBe(false)
  expect(due({ now, lastRequest: now - LEAD })).toBe(false)
  expect(due({ now, inputAt: now })).toBe(false)
})

it('does not retry after a failed ping until a newer request', () => {
  const lastRequest = now - LEAD
  const inputAt = now - minutes(70)
  expect(due({ now, lastRequest, inputAt, failedAfter: lastRequest + 1 })).toBe(false)
  expect(due({ now, lastRequest, inputAt, failedAfter: lastRequest - 1 })).toBe(true)
})

it('leaves the switch to the user', () => {
  expect(keepWarm.userActions).toEqual(['set'])
})
