import { expect, it } from 'vitest'
import { QUIET_MS, Relay } from '../extensions/voice-live/relay.ts'

it('collects fragments and delegation into one utterance after quiet', () => {
  const relay = new Relay(0)
  expect(relay.event({ type: 'session.input_transcript.delta', delta: 'Please fix ' }, 10)).toEqual(
    [],
  )
  relay.event(
    { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } },
    20,
  )
  relay.event({ type: 'session.input_transcript.delta', delta: 'the tests.' }, 30)
  expect(relay.tick(30 + QUIET_MS - 1)).toEqual([])
  expect(relay.tick(30 + QUIET_MS)).toEqual([{ say: 'Please fix the tests.', delegation: 'd1' }])
  expect(relay.tick(9000)).toEqual([])
  relay.event({ type: 'session.input_transcript.delta', delta: 'Please fix the tests.' }, 10000)
  expect(relay.tick(10000 + QUIET_MS)).toEqual([])
})

it('relays missed delegations, but not a one-word backchannel; output resets idle too', () => {
  const relay = new Relay(0)
  relay.event({ type: 'session.input_transcript.delta', delta: 'What changed ' }, 10)
  relay.event({ type: 'session.input_transcript.delta', delta: 'in there?' }, 20)
  expect(relay.tick(20 + QUIET_MS)).toEqual([{ say: 'What changed in there?' }])
  relay.event({ type: 'session.input_transcript.delta', delta: 'mm' }, 2000)
  expect(relay.tick(2000 + QUIET_MS)).toEqual([])
  relay.event({ type: 'session.output_transcript.delta', delta: 'Got it.' }, 4000)
  expect(relay.idleFor(4500)).toBe(500)
})
