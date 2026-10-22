import type { EntryRecord } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import {
  breakdownAt,
  diffAt,
  opensContext,
  ownStart,
  promptAt,
} from '../extensions/context/breakdown.ts'

let next = 1
// Fixtures write messages loosely; the module reads only the fields they set.
const entry = (kind: string, fields: { model?: unknown[]; data?: unknown } = {}) =>
  ({ id: next++, conversationId: 7, kind, createdAt: 0, ...fields }) as unknown as EntryRecord
const system = (
  sections?: Record<string, string | null>,
  toolsAdded?: { name: string; description: string; parameters: unknown }[],
  toolsRemoved?: { name: string }[],
) =>
  entry('pi.system', {
    model: [
      {
        role: 'system',
        content: '',
        timestamp: 0,
        ...(sections && { sections }),
        ...(toolsAdded && { toolsAdded }),
        ...(toolsRemoved && { toolsRemoved }),
      },
    ],
  })
const user = (text: string) =>
  entry('pi.user', {
    model: [{ role: 'user', content: text, timestamp: 0 }],
  })
const read = { name: 'read', description: 'Read a file', parameters: { type: 'object' } }
const bash = { name: 'bash', description: 'Run a command', parameters: { type: 'object' } }

it('breaks a baseline down into sections, tools and their token estimates, with the first response model', () => {
  const entries = [
    user('hello'),
    system({ identity: 'x'.repeat(35), rules: 'y'.repeat(70) }, [read, bash]),
    entry('pi.assistant', {
      model: [
        {
          role: 'assistant',
          content: [],
          provider: 'anthropic',
          model: 'claude',
          thinkingLevel: 'high',
          timestamp: 0,
        },
      ],
    }),
  ]
  const breakdown = breakdownAt(entries, 0)
  expect(breakdown.start).toBeUndefined()
  expect(breakdown.system).toBe(entries[1])
  expect(breakdown.prompt?.sections).toEqual([
    { key: 'identity', text: 'x'.repeat(35), tokens: 10 },
    { key: 'rules', text: 'y'.repeat(70), tokens: 20 },
  ])
  const readTokens = Math.ceil(JSON.stringify(read).length / 3.5)
  expect(breakdown.prompt?.tools.map((tool) => [tool.name, tool.tokens])).toEqual([
    ['read', readTokens],
    ['bash', Math.ceil(JSON.stringify(bash).length / 3.5)],
  ])
  expect(breakdown.model).toEqual({ provider: 'anthropic', model: 'claude', thinking: 'high' })
  expect(breakdown.tokens.prompt).toBe(30)
  expect(breakdown.tokens.total).toBe(breakdown.tokens.prompt + breakdown.tokens.tools)
})

it('replays patches in order: a value replaces in place, null removes, a re-added section goes last', () => {
  const entries = [
    system({ a: 'one', b: 'two', c: 'three' }),
    system({ b: 'TWO', a: null }),
    system({ a: 'again' }),
  ]
  expect(promptAt(entries, 1).sections.map((section) => [section.key, section.text])).toEqual([
    ['b', 'TWO'],
    ['c', 'three'],
  ])
  expect(promptAt(entries, 2).sections.map((section) => section.key)).toEqual(['b', 'c', 'a'])
})

it('starts the replay again at a reset and reads the brief it injects as the context start', () => {
  const brief = entry('pi.reset', {
    data: { lineage: { brief: { tally: 3 } } },
    model: [{ role: 'user', content: 'm'.repeat(350), timestamp: 0 }],
  })
  const entries = [system({ old: 'gone' }, [read]), brief, user('go'), system({ fresh: 'new' })]
  const breakdown = breakdownAt(entries, 1)
  expect(breakdown.injected).toMatchObject({ label: 'memory brief', tokens: 100 })
  expect(breakdown.prompt?.sections.map((section) => section.key)).toEqual(['fresh'])
  expect(breakdown.prompt?.tools).toEqual([])
  expect(breakdown.tokens.total).toBe(100 + breakdown.tokens.prompt)
  expect(opensContext(entries, 3, 1)).toBe(true)
  expect(opensContext(entries, 0, 0)).toBe(true)
})

it('counts an image as a fixed size, never its base64 length', () => {
  const reset = entry('pi.reset', {
    model: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', data: 'A'.repeat(500_000), mimeType: 'image/png' },
        ],
        timestamp: 0,
      },
    ],
  })
  expect(breakdownAt([reset], 0).injected?.tokens).toBe(Math.ceil((3 + 4800) / 3.5))
})

it('diffs a patch against the state before it, with token deltas for sections and tools', () => {
  const entries = [
    system({ keep: 'same', grow: 'abc' }, [read, bash]),
    system({ grow: 'abcdefghij'.repeat(7), extra: 'e'.repeat(35), keep: null }, undefined, [bash]),
  ]
  const diff = diffAt(entries, 1)
  expect(diff.sections).toEqual([
    { key: 'grow', change: 'changed', text: 'abcdefghij'.repeat(7), delta: 20 - 1 },
    { key: 'extra', change: 'added', text: 'e'.repeat(35), delta: 10 },
    { key: 'keep', change: 'removed', text: 'same', delta: -2 },
  ])
  expect(diff.tools.map((tool) => [tool.name, tool.change])).toEqual([['bash', 'removed']])
  expect(diff.delta).toBe(19 + 10 - 2 + diff.tools[0].delta)
})

it('treats a removed and re-added tool as unchanged unless its declaration changed', () => {
  const changedRead = { ...read, description: 'Read a file, with offsets' }
  const entries = [
    system({ a: 'x' }, [read, bash]),
    system(undefined, [read, bash], [{ name: 'read' }, { name: 'bash' }]),
    system(undefined, [changedRead], [{ name: 'read' }]),
  ]
  expect(diffAt(entries, 1).tools).toEqual([])
  expect(promptAt(entries, 1).tools.map((tool) => tool.name)).toEqual(['read', 'bash'])
  const diff = diffAt(entries, 2)
  expect(diff.tools.map((tool) => [tool.name, tool.change])).toEqual([['read', 'changed']])
  expect(promptAt(entries, 2).tools.map((tool) => tool.name)).toEqual(['bash', 'read'])
})

it('folds a remove-all patch into the re-add after it, so a reorder shows only real changes', () => {
  const entries = [
    system({ a: 'one', b: 'two' }),
    system({ a: null, b: null }),
    system({ b: 'two', a: 'ONE' }),
  ]
  expect(diffAt(entries, 2).sections.map((section) => [section.key, section.change])).toEqual([
    ['a', 'changed'],
  ])
})

it('finds where a fork’s own entries start', () => {
  const inherited = { ...user('root'), conversationId: 1 } as unknown as EntryRecord
  const own = user('mine')
  expect(ownStart([inherited, own], 7)).toBe(1)
})
