import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { classify } from '../extensions/minimap/marks.ts'

let next = 1
const entry = (kind: string, rest: Partial<EntryRecord> = {}) =>
  ({ id: next++, conversationId: 7, kind, ...rest }) as EntryRecord
const user = (text: string) =>
  entry('pi.user', { input: true, model: [{ role: 'user', content: text, timestamp: 1 }] })
const assistant = (text: string, calls: { name: string; arguments: object }[] = []) =>
  entry('pi.assistant', {
    model: [
      {
        role: 'assistant',
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...calls.map((call, index) => ({ type: 'toolCall', id: `c${index}`, ...call })),
        ],
        timestamp: 2,
      } as never,
    ],
  })

it('marks inputs, the last answer of each turn, and milestone tool calls and entries', () => {
  const marks = classify([
    user('Fix the **lander**'),
    assistant('Looking.', [{ name: 'branch', arguments: { title: 'Lander fix', prompt: 'x' } }]),
    entry('pi.tool-result'),
    assistant('Started the branch.'),
    entry('board.message', { input: true, data: { from: 412, text: 'Landed abc' } }),
    assistant('', [{ name: 'instance', arguments: { action: 'start' } }]),
    entry('workspaces.lander-report', {
      data: { id: 'x', outcome: { outcome: 'landed', sha: '471d47b98044' } },
    }),
    entry('board.message', { input: true, data: { from: 'user', text: 'thanks' } }),
  ])
  expect(marks.map(({ kind, text }) => [kind, text])).toEqual([
    ['user', 'Fix the lander'],
    ['branch', 'Lander fix'],
    ['answer', 'Started the branch.'],
    ['message', 'Landed abc'],
    ['preview', 'Preview started'],
    ['landed', 'Landed 471d47b'],
    ['user', 'thanks'],
  ])
})
