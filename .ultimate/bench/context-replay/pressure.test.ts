import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { analyze } from './replay.ts'

test('pressure masking charges once, counts later resends and rereads, and unions overlap with offload', () => {
  const assistant = (
    timestamp: number,
    content: AssistantMessage['content'],
  ): AssistantMessage => ({
    role: 'assistant',
    provider: 'anthropic',
    api: 'anthropic-messages',
    model: 'test',
    content,
    timestamp,
    stopReason: 'stop',
    usage: {
      input: 1,
      output: 10,
      cacheRead: 80000,
      cacheWrite: 100,
      totalTokens: 80111,
      cost: {
        input: 0.000004,
        output: 0.0002,
        cacheRead: 0.032,
        cacheWrite: 0.0005,
        total: 0.032704,
      },
    },
  })
  const first = assistant(1000, [
    { type: 'toolCall', id: 'a', name: 'bash', arguments: { command: 'inspect' } },
  ])
  const result: Message = {
    role: 'toolResult',
    toolCallId: 'a',
    toolName: 'bash',
    content: [{ type: 'text', text: 'old output\n'.repeat(5000) }],
    timestamp: 1100,
    isError: false,
  }
  const later: Message = { role: 'user', content: 'new context '.repeat(20000), timestamp: 1200 }
  const second = assistant(2000, [
    { type: 'toolCall', id: 'b', name: 'bash', arguments: { command: 'inspect' } },
  ])
  const report = analyze(
    [
      {
        conversation: { id: 1 },
        entries: [first, result, later, second, assistant(3000, [])].map((m, i) => ({
          id: i + 1,
          conversationId: 1,
          kind:
            m.role === 'assistant'
              ? 'pi.assistant'
              : m.role === 'toolResult'
                ? 'pi.tool-result'
                : 'pi.user',
          model: [m],
        })),
      },
    ],
    [{ id: 'test', provider: 'anthropic', contextWindow: 100000 }],
    { ttl: 300000, rewrite: 20000 },
  )
  assert.equal(report.quality.masked, 1)
  assert.equal(report.quality.maskedThenReread, 1)
  assert.ok(report.projections['pressure masking'].cost > 0)
  assert.equal(report.projections['pressure masking'].events, 2)
  assert.ok(
    report.projections['combined eligible'].tokenResends <
      report.projections.offload.tokenResends + report.projections['pressure masking'].tokenResends,
  )
})
