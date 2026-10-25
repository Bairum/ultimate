import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { analyze, excerpt, get, positions } from './replay.ts'

function assistant(
  timestamp: number,
  content: AssistantMessage['content'] = [],
  cacheWrite = 30000,
): AssistantMessage {
  return {
    role: 'assistant',
    provider: 'anthropic',
    api: 'anthropic-messages',
    model: 'test',
    content,
    timestamp,
    stopReason: 'stop',
    thinkingLevel: 'medium',
    usage: {
      input: 10,
      output: 10,
      cacheRead: 50000,
      cacheWrite,
      totalTokens: 80020,
      cost: {
        input: 0.00004,
        output: 0.0002,
        cacheRead: 0.02,
        cacheWrite: cacheWrite * 0.000005,
        total: 0.17024,
      },
    },
  }
}
const system = (sections: Record<string, string | null>): Message => ({
  role: 'system',
  content: '',
  sections,
  timestamp: 1,
})

test('attributes rewrites in order, detects full re-add, projects TTL and avoids inherited request spend', () => {
  const messages: { kind: string; model?: Message[]; head?: 'self'; conversationId?: number }[] = [
    { kind: 'pi.system', model: [system({ instructions: 'a', plan: 'b' })] },
    { kind: 'pi.assistant', model: [assistant(1000)] },
    { kind: 'pi.system', model: [system({ instructions: null, plan: null })] },
    { kind: 'pi.system', model: [system({ instructions: 'a', plan: 'c' })] },
    { kind: 'pi.assistant', model: [assistant(2000)] },
    { kind: 'pi.assistant', model: [assistant(602000)] },
    { kind: 'pi.reset', head: 'self' },
    { kind: 'pi.assistant', model: [assistant(603000)] },
    { kind: 'pi.assistant', model: [{ ...assistant(604000), thinkingLevel: 'high' }] },
    { kind: 'pi.assistant', model: [assistant(605000)], conversationId: 2 },
  ]
  const report = analyze(
    [
      {
        conversation: { id: 1, label: 'coordinator' },
        entries: messages.map((m, i) => ({ id: i + 1, conversationId: 1, ...m })),
      },
    ],
    [],
    { ttl: 300000, rewrite: 20000 },
  )
  assert.equal(report.requests, 5)
  for (const cause of [
    'first request/context',
    'idle TTL',
    'compaction/reset',
    'model/thinking switch',
    'system-prompt change',
  ])
    assert.equal(report.attribution[cause].count, 1, cause)
  assert.equal(report.sections.plan.readdTokens, 1)
  assert.equal((report.rewrites[1] as { removeAllReadd: boolean }).removeAllReadd, true)
  assert.equal(report.projections['1h cache'].events, 1)
  assert.ok(Math.abs(report.projections['1h cache'].saved - 0.228) < 1e-9)
})

test('offload projection counts only request resends up to reset and excludes read results', () => {
  const full = 'some ordinary output\n'.repeat(2000)
  const result: Message = {
    role: 'toolResult',
    toolCallId: 'a',
    toolName: 'bash',
    content: [{ type: 'text', text: full }],
    isError: false,
    timestamp: 2,
  }
  const entries = [
    { id: 1, conversationId: 1, kind: 'pi.tool-result', model: [result] },
    { id: 2, conversationId: 1, kind: 'pi.assistant', model: [assistant(1000)] },
    { id: 3, conversationId: 1, kind: 'pi.assistant', model: [assistant(2000)] },
    { id: 4, conversationId: 1, kind: 'pi.reset', head: 'self' as const },
    { id: 5, conversationId: 1, kind: 'pi.assistant', model: [assistant(3000)] },
  ]
  const r = analyze([{ conversation: { id: 1 }, entries }], [], { ttl: 300000, rewrite: 20000 })
  assert.equal(r.projections.offload.events, 2)
  assert.ok(r.projections.offload.tokenResends > 10000)
  const read = analyze(
    [
      {
        conversation: { id: 1 },
        entries: entries.map((e) =>
          e.id === 1 ? { ...e, model: [{ ...result, toolName: 'read' }] } : e,
        ),
      },
    ],
    [],
    { ttl: 300000, rewrite: 20000 },
  )
  assert.equal(read.projections.offload.saved, 0)
})

test('excerpt preserves capped head, tail and matches under UTF-8 byte ceiling', () => {
  const full = [
    'head',
    ...Array.from({ length: 200 }, (_, i) => `line ${i} ${'😀'.repeat(400)}`),
    'error: found',
    'tail',
  ].join('\n')
  const output = excerpt(full, '/tmp/output.txt')!
  assert.ok(Buffer.byteLength(output) <= 8192)
  assert.ok(output.startsWith('head\n'))
  assert.ok(output.includes('tail'))
  assert.ok(output.includes('Matching lines:\n202: error: found'))
  assert.ok(output.includes('Full output: /tmp/output.txt'))
  assert.equal(excerpt('small', '/tmp/output.txt'), undefined)
})

test('block positions group tool runs, not ordinary text or thinking', () => {
  const call = (id: string) => ({
    type: 'toolCall' as const,
    id,
    name: 'read',
    arguments: { path: id },
  })
  const result = (id: string): Message => ({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text: 'x' }],
    isError: false,
    timestamp: 2,
  })
  assert.equal(
    positions([
      assistant(1, [{ type: 'text', text: 'x' }, call('a'), call('b')]),
      result('a'),
      result('b'),
      assistant(3, [
        { type: 'text', text: 'x' },
        { type: 'text', text: 'y' },
      ]),
    ]),
    5,
  )
})

test('GET rejects mutation and unapproved endpoints before fetching', async () => {
  await assert.rejects(get('http://127.0.0.1:1', '/api/actions/run'), /Disallowed GET/)
})
