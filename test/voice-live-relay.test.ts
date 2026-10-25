import { expect, it } from 'vitest'
import { HANDOFF_MS, QUIET_MS, Relay } from '../extensions/voice-live/relay.ts'
import type { LiveEvent } from '../extensions/voice-live/relay.ts'

const said = (delta: string): LiveEvent => ({ type: 'session.input_transcript.delta', delta })
const spoken = (delta: string): LiveEvent => ({ type: 'session.output_transcript.delta', delta })
const delegated = (id: string): LiveEvent => ({
  type: 'session.delegation.created',
  delegation: { id, target: 'client' },
})

it('keeps small talk in Voice and forwards a request on delegation', () => {
  const relay = new Relay(0)
  relay.event(said('Can you hear me?'), 10)
  expect(relay.event(spoken('Yep, I can hear you.'), 500)).toEqual([
    { log: { role: 'daniel', text: 'Can you hear me?' } },
  ])
  expect(relay.tick(500 + QUIET_MS)).toEqual([
    { log: { role: 'live', text: 'Yep, I can hear you.' } },
  ])
  relay.event(said('Land the side chat branch'), 3000)
  expect(relay.event(delegated('d1'), 3500)).toEqual([
    { log: { role: 'daniel', text: 'Land the side chat branch' } },
    { forward: 'Land the side chat branch', delegation: 'd1' },
  ])
})

// Daniel's round-2 test: GPT-Live clarified, said "Okay, asking Ultimate now." and never delegated; nothing was sent.
it('forwards the exchange itself when GPT-Live announces a handoff it never delegates', () => {
  const relay = new Relay(0)
  relay.event(said('Can you ask Ultimate to check which conversations are ongoing'), 10)
  relay.event(spoken('Do you mean which conversations are going on in Ultimate?'), 2000)
  relay.event(said('Yes'), 4000)
  relay.event(spoken('Okay, asking Ultimate now.'), 5000)
  expect(relay.tick(5000 + QUIET_MS)).toEqual([
    { log: { role: 'live', text: 'Okay, asking Ultimate now.' } },
  ])
  expect(relay.tick(5000 + QUIET_MS + HANDOFF_MS)).toEqual([
    {
      forward:
        'Daniel: Can you ask Ultimate to check which conversations are ongoing\nVoice: Do you mean which conversations are going on in Ultimate?\nDaniel: Yes',
    },
  ])
  // A late delegation for the same handoff forwards nothing twice, and says nothing.
  expect(relay.event(delegated('late'), 20_000)).toEqual([])
})

it('reports a handoff with nothing to pass on instead of staying silent', () => {
  const relay = new Relay(0)
  relay.event(spoken('Passing that on.'), 100)
  relay.tick(100 + QUIET_MS)
  expect(relay.tick(100 + QUIET_MS + HANDOFF_MS)).toEqual([
    { notSent: 'There was no request to pass on.' },
  ])
})

it('does not log Ultimate answers being read out as GPT-Live lines; any speech resets idle', () => {
  const relay = new Relay(0)
  relay.spoke()
  relay.event(spoken('The tests pass.'), 100)
  expect(relay.tick(100 + QUIET_MS)).toEqual([])
  expect(relay.idleFor(600)).toBe(500)
})
