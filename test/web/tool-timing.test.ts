import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import { expect, it } from 'vitest'
import { callsStart, toolCallView } from '../../web/src/app/model.ts'

const call: ToolCall = { type: 'toolCall', id: 'call-1', name: 'subagent', arguments: {} }
// The answer that made the call was asked at 10:00:00 and streamed for 4 s.
const answer = { timestamp: 1_000_000, durationMs: 4_000 } as AssistantMessage

it('times a call first seen mid-run from when its answer ended, not from when the page saw it', () => {
  const view = toolCallView(call, {
    slot: { callId: call.id, name: call.name, status: 'running' },
    streaming: false,
    busy: true,
    startedAt: callsStart(answer),
  })
  expect(view.status).toBe('running')
  expect(view.startedAt).toBe(1_004_000)
  expect(view.endedAt).toBeUndefined()
})

it('times a finished call from its result, also when the page never saw it run', () => {
  const message = {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [],
    isError: false,
    timestamp: 1_040_000,
    durationMs: 35_000,
  } as ToolResultMessage
  const result = { message, diagnostics: [] }
  const view = toolCallView(call, { result, streaming: false, busy: false })
  expect([view.startedAt, view.endedAt]).toEqual([1_005_000, 1_040_000])
  // A legacy result without a duration falls back to the answer's end.
  const { durationMs: _, ...legacy } = message
  const old = toolCallView(call, {
    result: { message: legacy, diagnostics: [] },
    streaming: false,
    busy: false,
    startedAt: callsStart(answer),
  })
  expect([old.startedAt, old.endedAt]).toEqual([1_004_000, 1_040_000])
})

it('gives an interrupted call no times, so no clock ticks for it', () => {
  const view = toolCallView(call, { streaming: false, busy: false, startedAt: 1_004_000 })
  expect(view.status).toBe('interrupted')
  expect(view.startedAt).toBeUndefined()
})
