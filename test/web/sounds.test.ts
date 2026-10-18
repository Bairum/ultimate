import { expect, it } from 'vitest'
import type { OverviewRow } from '../../extensions/conversations/types.ts'
import { cuesOf, listener, settle } from '../../extensions/sounds/cues.ts'
import type { Watched } from '../../extensions/sounds/cues.ts'

const agent = 7
const answered = (answerId: number, extra: Partial<OverviewRow> = {}): OverviewRow => ({
  runState: 'answered',
  inputId: answerId - 1,
  answerId,
  ...extra,
})
const watched = (extra: Partial<Watched> = {}): Watched => ({
  agent,
  messages: [],
  extracting: false,
  ...extra,
})
const sounds = (state: Watched) => cuesOf(state).map((cue) => cue.sound)

it('tells a question, a finished answer and a failed run apart', () => {
  expect(cuesOf(watched({ row: answered(10) }))).toEqual([
    { key: '7:10', sound: 'finished', settled: false },
  ])
  expect(cuesOf(watched({ row: answered(10), asked: { conversation: agent, entry: 10 } }))).toEqual(
    [{ key: '7:10', sound: 'input', settled: true }],
  )
  expect(cuesOf(watched({ row: { runState: 'error', inputId: 4 } }))).toEqual([
    { key: '7:4', sound: 'failed', settled: true },
  ])
  const messages = [
    { id: 1, from: agent, to: 'user' as const, reply: true },
    { id: 2, from: agent, to: 'user' as const, reply: false },
  ]
  expect(cuesOf(watched({ messages }))).toEqual([
    { key: 'message:1', sound: 'input', settled: true },
    { key: 'message:2', sound: 'finished', settled: true },
  ])
})

it('stays quiet for everything that is not @ultimate talking to the user', () => {
  // Answering another agent's message, not the user.
  expect(sounds(watched({ row: answered(10, { internalInput: true }) }))).toEqual([])
  // A card on another conversation's answer does not make this one a question.
  expect(sounds(watched({ row: answered(10), asked: { conversation: 9, entry: 10 } }))).toEqual([
    'finished',
  ])
  // Messages from other agents to the user, and @ultimate's messages to branches.
  const messages = [
    { id: 1, from: 30726, to: 'user' as const, reply: true },
    { id: 2, from: 110108, to: 'user' as const, reply: false },
    { id: 3, from: agent, to: 158849, reply: true },
    { id: 4, from: 'user' as const, to: agent, reply: false },
  ]
  expect(sounds(watched({ messages }))).toEqual([])
  expect(sounds(watched({ row: { runState: 'working', inputId: 9 } }))).toEqual([])
  expect(cuesOf({ messages, extracting: false })).toEqual([])
})

it('takes what is there at first as heard, and sounds later news once', () => {
  const hear = listener()
  const message = { id: 1, from: agent, to: 'user' as const, reply: true }
  expect(hear(watched({ messages: [message] }), 0).due).toEqual([])
  expect(hear(watched({ messages: [message] }), 1).due).toEqual([])
  const next = { id: 2, from: agent, to: 'user' as const, reply: true }
  expect(hear(watched({ messages: [message, next] }), 2).due.map((cue) => cue.key)).toEqual([
    'message:2',
  ])
  expect(hear(watched({ messages: [message, next] }), 3).due).toEqual([])
  expect(hear(watched({ row: { runState: 'error', inputId: 30 } }), 4).due).toEqual([
    { key: '7:30', sound: 'failed', settled: true },
  ])
})

it('waits for question extraction before an answer sounds as finished', () => {
  const hear = listener()
  hear(watched(), 0)
  // No extraction showed up within the grace: finished.
  expect(hear(watched({ row: answered(10) }), 100)).toEqual({ due: [], waiting: true })
  expect(hear(watched({ row: answered(10) }), 100 + settle).due.map((cue) => cue.sound)).toEqual([
    'finished',
  ])
  // An extraction runs past the grace, then attaches a card: a question, once.
  expect(hear(watched({ row: answered(20), extracting: true }), 10_000).due).toEqual([])
  expect(hear(watched({ row: answered(20), extracting: true }), 20_000).due).toEqual([])
  const asked = { conversation: agent, entry: 20 }
  expect(hear(watched({ row: answered(20), asked }), 20_100).due.map((cue) => cue.sound)).toEqual([
    'input',
  ])
  expect(hear(watched({ row: answered(20), asked }), 20_200).due).toEqual([])
  // An extraction that finds nothing: finished once it ends.
  expect(hear(watched({ row: answered(30), extracting: true }), 30_000).due).toEqual([])
  expect(hear(watched({ row: answered(30) }), 30_000 + settle).due.map((cue) => cue.sound)).toEqual(
    ['finished'],
  )
})
