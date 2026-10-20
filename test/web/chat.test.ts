import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import {
  chatRows,
  groupAside,
  runOf,
  setAsideIds,
  windowGaps,
  windowKey,
} from '../../web/src/app/chat.ts'
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
const names = new Set(['message', 'branch'])
const visible = (block: { name: string }) => names.has(block.name)

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

  it('keeps the calls its test keeps, by more than their name', () => {
    nextId = 1
    const script = { ...call('codemode'), arguments: { sent: true } }
    const rows = chatRows(
      [assistant('toolUse', call('codemode'), script), assistant('stop', text('Asked.'))],
      (block) => block.name === 'codemode' && block.arguments?.sent === true,
    )
    expect(shape(rows)).toEqual(['[1:0] ×1', '1:1', '2'])
  })
})

describe('revealing a chat entry', () => {
  it('finds the folded run an entry first shows in, past its first entry and in split responses', () => {
    nextId = 1
    const rows = chatRows(
      [
        user('check'),
        assistant('toolUse', call('bash')),
        assistant('toolUse', call('read')),
        assistant('toolUse', call('message'), call('bash')),
        assistant('stop', text('Done.')),
      ],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '[2 3] ×2', '4:0', '[4:1] ×1', '5'])
    expect(runOf(rows, 2)).toBe(rows[1])
    expect(runOf(rows, 3)).toBe(rows[1])
    // A split response first shows as its visible call, so revealing it opens nothing.
    expect(runOf(rows, 4)).toBeUndefined()
    expect(runOf(rows, 1)).toBeUndefined()
    expect(runOf(rows, 5)).toBeUndefined()
    expect(runOf(rows, 99)).toBeUndefined()
  })

  it('opens the run when a split response starts with folded work', () => {
    nextId = 1
    const rows = chatRows(
      [user('go'), assistant('toolUse', call('bash'), call('message'))],
      visible,
    )
    expect(shape(rows)).toEqual(['1', '[2:0] ×1', '2:1'])
    expect(runOf(rows, 2)).toBe(rows[1])
  })
})

const at = (id: number, head?: number) => ({ id, head }) as unknown as EntryRecord

describe('windowGaps', () => {
  it('reads past the window head to the newest kept entry after consecutive compactions', () => {
    // The second compaction (500) heads the window; the first (450) was superseded, newer than `older` and left out.
    const window = [at(500, 300), at(400), at(401), at(499)]
    const [range] = windowGaps(window, 400, [])
    expect(range).toEqual([400, 501])
    expect(range[0] <= 450 && 450 < range[1]).toBe(true)
  })

  it('bridges rows kept from before a resync to the new window', () => {
    expect(windowGaps([at(900), at(901)], 900, [at(700), at(705)])).toEqual([[706, 900]])
  })

  it('sees a reconnect after consecutive compactions as a fresh window though older stays', () => {
    const before = [at(500, 300), at(400), at(499)]
    const after = [at(600, 300), at(400), at(499), at(601)]
    expect(windowKey(after, 400)).not.toBe(windowKey(before, 400))
    // Appends keep the window: no refill.
    expect(windowKey([...before, at(502)], 400)).toBe(windowKey(before, 400))
    // The new head reaches past both superseded markers.
    expect(windowGaps(after, 400, [])).toEqual([[400, 602]])
  })

  it('leaves a contiguous window without a head marker alone', () => {
    expect(windowGaps([at(900), at(901)], 900, [at(899)])).toEqual([])
    expect(windowGaps([at(900), at(901)], 900, [])).toEqual([])
  })
})

describe('set-aside rows', () => {
  const back = (point: number) => entry('lineage.rewound', undefined, { setAside: point })
  it('sets aside what came after each go-back, and what a later go-back before it reaches', () => {
    nextId = 1
    // 1 2 3 | back to 1 (4) | 5 6 | back to 4 (7), the first note itself | 8
    const entries = [
      user('a'),
      user('b'),
      user('c'),
      back(1),
      user('d'),
      user('e'),
      back(4),
      user('f'),
    ]
    // Going back to the first note keeps what it set aside (2, 3) aside, and sets aside 5 and 6.
    expect([...setAsideIds(entries)].toSorted((a, b) => a - b)).toEqual([2, 3, 5, 6])
    // Back before the first go-back: its note leaves too.
    const again = [...entries, back(1)]
    expect([...setAsideIds(again)].toSorted((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(setAsideIds([user('x')]).size).toBe(0)
  })
  it('folds each stretch of set-aside rows into one group with its steps', () => {
    nextId = 1
    const entries = [user('a'), user('b'), system(), user('c'), back(1), user('d')]
    const grouped = groupAside(
      entries.map((value) => ({ entry: value })),
      setAsideIds(entries),
    )
    expect(
      grouped.map((row) =>
        'aside' in row
          ? `aside ${row.aside.length} ×${row.steps}`
          : String((row as ChatPart).entry.id),
      ),
    ).toEqual(['1', 'aside 3 ×2', '5', '6'])
  })
})
