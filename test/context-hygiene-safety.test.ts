import type { JsonObject } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { candidates, rewrite } from '../extensions/context-hygiene/rewrite.ts'
import { Ledger } from '../extensions/context-hygiene/api.ts'
import type { Decision } from '../extensions/context-hygiene/api.ts'

const read = (
  id: string,
  args: Record<string, string | number>,
  output: string,
  details?: Extract<Message, { role: 'toolResult' }>['details'],
): Message[] => [
  {
    ...fauxAssistantMessage(''),
    content: [{ type: 'toolCall', id, name: 'read', arguments: args }],
  },
  {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text: output }],
    isError: false,
    timestamp: 1,
    ...(details ? { details } : {}),
  },
]
const applied: Decision = { reason: 'empty', tokens: 1, state: 'applied', at: 1 }

it('uses returned truncation coverage, never treating a truncated whole read as whole', () => {
  const later = read('new', { path: 'x' }, 'new\n'.repeat(20), {
    truncation: { truncated: true, outputLines: 20, firstLineExceedsLimit: false },
  })
  expect(
    candidates(
      [...read('old', { path: 'x', offset: 30, limit: 2 }, 'old\nold'), ...later],
      '/work',
      1,
    ),
  ).toEqual({})
  expect(
    candidates(
      [...read('old', { path: 'x', offset: 5, limit: 2 }, 'old\nold'), ...later],
      '/work',
      1,
    ).old,
  ).toMatchObject({ reason: 'superseded', path: 'x' })
})
it.each<JsonObject>([
  { truncated: true, outputLines: 0, firstLineExceedsLimit: true },
  { truncated: true },
])('refuses unknown or absent returned coverage: %j', (truncation) => {
  expect(
    candidates(
      [
        ...read('old', { path: 'x' }, 'old'),
        ...read('new', { path: 'x' }, 'unavailable', { truncation }),
      ],
      '/work',
      1,
    ),
  ).toEqual({})
})
it('bounds an untruncated partial read by its returned lines, not its requested limit', () => {
  expect(
    candidates(
      [
        ...read('old', { path: 'x', offset: 5, limit: 1 }, 'old'),
        ...read('new', { path: 'x', offset: 1, limit: 100 }, 'only one line'),
      ],
      '/work',
      1,
    ),
  ).toEqual({})
})
it.each(['bash', 'edit', 'write', 'custom_mutator'])(
  'blocks partial supersession across %s regardless of its arguments',
  (name) => {
    const middle: Message = {
      ...fauxAssistantMessage(''),
      content: [{ type: 'toolCall', id: 'middle', name, arguments: {} }],
    }
    const old = read('old', { path: 'x', offset: 2, limit: 1 }, 'old')
    const partial = read('new', { path: 'x', offset: 1, limit: 10 }, 'a\nb\nc')
    expect(candidates([...old, middle, ...partial], '/work', 1)).toEqual({})
    expect(
      candidates([...old, middle, ...read('new', { path: 'x' }, 'current')], '/work', 1).old.reason,
    ).toBe('superseded')
  },
)
it.each(['read', 'grep'])('allows partial coverage across known read-only %s calls', (name) => {
  const middle: Message = {
    ...fauxAssistantMessage(''),
    content: [{ type: 'toolCall', id: 'middle', name, arguments: {} }],
  }
  expect(
    candidates(
      [
        ...read('old', { path: 'x', offset: 2, limit: 1 }, 'old'),
        middle,
        ...read('new', { path: 'x', offset: 1, limit: 10 }, 'a\nb\nc'),
      ],
      '/work',
      1,
    ).old.reason,
  ).toBe('superseded')
})
it.each(['both', 'call', 'result', 'empty'])(
  'rejects ambiguous or empty ids during detection and rewrite: %s',
  (mode) => {
    const id = mode === 'empty' ? '' : 'old'
    const own = read(id, { path: 'x' }, 'old', { useless: true })
    const repeat =
      mode === 'both' ? own : mode === 'call' ? [own[0]] : mode === 'result' ? [own[1]] : []
    const messages = [...own, ...repeat, ...read('new', { path: 'x' }, 'new')]
    expect(candidates(messages, '/work', 1)).toEqual({})
    // A repeated call with exactly one result is not ambiguous to rewrite's result-id guard.
    const output = rewrite(messages, { [id]: applied })
    expect(output[1]).toEqual(
      mode === 'call'
        ? { ...own[1], content: [{ type: 'text', text: '[Elided: empty result]' }] }
        : own[1],
    )
  },
)
it('skips already decided ids and keeps a path-specific placeholder stable', () => {
  const messages = [
    ...read('old', { path: './x' }, 'old'),
    ...read('new', { path: '/work/x' }, 'new'),
  ]
  const decisions = candidates(messages, '/work', 1)
  expect(candidates(messages, '/work', 2, decisions)).toEqual({})
  decisions.old.state = 'applied'
  expect(rewrite(messages, decisions)[1]).toMatchObject({
    content: [
      {
        type: 'text',
        text: '[Elided from context: superseded by a later read of ./x. Read it again if you need it.]',
      },
    ],
  })
})
it('checkpoints the ledger after 64 deltas', () => {
  const value = { version: 1 as const, decisions: {}, stats: { appliedTokens: 0, requests: 0 } }
  expect(Ledger.definition.checkpointWhen(value, [], { deltasSinceBase: 63 })).toBe(false)
  expect(Ledger.definition.checkpointWhen(value, [], { deltasSinceBase: 64 })).toBe(true)
})
