import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { chatRows } from '../../web/src/app/chat.ts'
import type { ChatPart, WorkRun } from '../../web/src/app/chat.ts'

let nextId = 1
const entry = (kind: string, message?: object, data?: object) =>
  ({
    id: nextId++,
    conversationId: 1,
    kind,
    ...(message ? { model: [message] } : {}),
    ...(data ? { data } : {}),
  }) as unknown as EntryRecord
const user = (text: string) => entry('pi.user', { role: 'user', content: text })
const system = () => entry('pi.system', { role: 'system', sections: {} })
const thinking = (text = 'Considering') => ({ type: 'thinking', thinking: text })
const text = (value: string) => ({ type: 'text', text: value })
const call = (name: string) => ({ type: 'toolCall', id: `call-${nextId}-${name}`, name })
const assistant = (stopReason: string, ...content: object[]) =>
  entry('pi.assistant', { role: 'assistant', stopReason, content })
const result = () => entry('pi.tool-result', { role: 'toolResult', toolCallId: 'orphan' })
const visible = new Set(['message', 'branch'])

/** Rows as ids: `n` a whole entry, `n:a,b` its blocks, `[…] ×steps` a folded run. */
const shape = (rows: (ChatPart | WorkRun)[]) =>
  rows.map((row) => ('work' in row ? `[${row.work.map(part).join(' ')}] ×${row.steps}` : part(row)))
const part = (row: ChatPart) =>
  row.blocks ? `${row.entry.id}:${row.blocks.join(',')}` : String(row.entry.id)

describe('chat rows', () => {
  it('folds a run of tool calls between an input and its answer, and leaves the answer whole', () => {
    nextId = 1
    const rows = chatRows(
      [
        user('check the tests'),
        system(),
        assistant('toolUse', thinking(), call('bash')),
        assistant('toolUse', text('Reading it.'), call('read'), call('read')),
        assistant('stop', thinking(), text('All green.')),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '[2 3 4] ×4', '5'])
  })

  it('keeps visible tool calls as rows that split a run, in their order', () => {
    nextId = 1
    const rows = chatRows(
      [
        assistant('toolUse', thinking(), call('message')),
        assistant('toolUse', call('bash'), call('branch'), call('note'), call('read')),
        assistant('toolUse', call('message')),
        assistant('stop', text('Started it.')),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['[1:0] ×1', '1:1', '[2:0] ×1', '2:1', '[2:2,3] ×2', '3', '4'])
  })

  it('ends a run at messages and other entries, which stay visible', () => {
    nextId = 1
    const rows = chatRows(
      [
        entry('board.message', undefined, { from: 4, text: 'Landed' }),
        assistant('toolUse', call('bash')),
        result(),
        entry('lineage.note', undefined, { text: 'note' }),
        assistant('toolUse', call('edit')),
        assistant('stop', text('Done.')),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '[2 3] ×2', '4', '[5] ×1', '6'])
  })

  it('shows a run without steps as it is, and errors whole', () => {
    nextId = 1
    const rows = chatRows(
      [
        user('hello'),
        system(),
        assistant('toolUse', thinking(''), text('Let me look.')),
        assistant('error'),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '2', '3', '4'])
  })

  it('folds the open run at the end of a working conversation', () => {
    nextId = 1
    const rows = chatRows([user('go'), assistant('toolUse', call('bash'))], visible)
    expect(shape(rows)).toEqual(['1', '[2] ×1'])
  })
})
