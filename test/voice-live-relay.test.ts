import { expect, it } from 'vitest'
import { QUIET_MS, Relay } from '../extensions/voice-live/relay.ts'
import type { LiveEvent } from '../extensions/voice-live/relay.ts'

const said = (delta: string): LiveEvent => ({ type: 'session.input_transcript.delta', delta })
const spoken = (delta: string): LiveEvent => ({ type: 'session.output_transcript.delta', delta })
const delegated = (id: string): LiveEvent => ({
  type: 'session.delegation.created',
  delegation: { id, target: 'client' },
})

it('keeps small talk in Voice and forwards nothing Daniel did not confirm', () => {
  const relay = new Relay(0)
  expect(relay.event(said('Can you hear me?'), 10)).toEqual([])
  expect(relay.event(spoken('Yes, loud and clear.'), 500)).toEqual([
    { log: { role: 'daniel', text: 'Can you hear me?' } },
  ])
  expect(relay.tick(500 + QUIET_MS)).toEqual([
    { log: { role: 'live', text: 'Yes, loud and clear.' } },
  ])
  // A delegation without a confirmed question forwards nothing.
  expect(relay.event(delegated('d0'), 3000)).toEqual([])
  expect(relay.tick(9000)).toEqual([])
})

it('forwards the confirmed request with its delegation, and a missed handoff only after a yes', () => {
  const relay = new Relay(0)
  relay.event(said('Um, land the side chat branch'), 10)
  relay.event(spoken('Should I pass this to Ultimate: land the side chat branch?'), 1000)
  relay.event(said('Yes please'), 3000)
  expect(relay.event(delegated('d1'), 3500)).toEqual([
    { log: { role: 'daniel', text: 'Yes please' } },
    { forward: 'land the side chat branch', delegation: 'd1' },
  ])
  expect(relay.tick(20_000)).toEqual([])

  // GPT-Live asks and Daniel says yes, but no delegation arrives: forwarded after the quiet time.
  relay.event(spoken('Should I pass this to Ultimate: run the tests?'), 30_000)
  relay.event(said('yeah'), 31_000)
  expect(relay.tick(31_000 + QUIET_MS)).toEqual([
    { log: { role: 'daniel', text: 'yeah' } },
    { forward: 'run the tests' },
  ])

  // A "no" leaves the question unconfirmed: nothing goes.
  relay.event(spoken('Should I pass this to Ultimate: delete the branch?'), 40_000)
  relay.event(said('No, wait'), 41_000)
  expect(relay.tick(60_000)).toEqual([{ log: { role: 'daniel', text: 'No, wait' } }])
  expect(relay.event(delegated('d2'), 60_100)).toEqual([])
})

it('does not log Ultimate answers being read out as GPT-Live lines; any speech resets idle', () => {
  const relay = new Relay(0)
  relay.spoke()
  relay.event(spoken('The tests pass.'), 100)
  expect(relay.tick(100 + QUIET_MS)).toEqual([])
  expect(relay.idleFor(600)).toBe(500)
})

it('without confirmation forwards what Daniel said on delegation', () => {
  const relay = new Relay(0, false)
  relay.event(said('Land the side chat branch'), 10)
  expect(relay.event(delegated('d1'), 500)).toEqual([
    { log: { role: 'daniel', text: 'Land the side chat branch' } },
    { forward: 'Land the side chat branch', delegation: 'd1' },
  ])
})
