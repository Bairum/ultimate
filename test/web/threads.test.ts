import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { threadsOf } from '../../extensions/threads/threads.tsx'
import type { Message } from '../../extensions/messages/refs.ts'
import { laneAt, laneColumns } from '../../web/src/app/compact.ts'

// Shapes as @ultimate's stored history has them: inputs carry `input`, a response its tool calls, a result its call id.
const ULTIMATE = 10
let next = 1
const entry = (kind: string, rest: Partial<EntryRecord> = {}) =>
  ({ id: next++, conversationId: ULTIMATE, kind, ...rest }) as EntryRecord
const prompt = () =>
  entry('pi.user', { input: true, model: [{ role: 'user', content: '', timestamp: 0 }] })
const fromBranch = (from: number | 'user', id: number, kind = 'board.message', input = true) =>
  entry(kind, { ...(input ? { input: true } : {}), data: { id, from } })
const landed = (branch: number) =>
  entry('workspaces.lander-report', {
    input: true,
    data: {
      id: `${branch}-x`,
      outcome: { outcome: 'landed', conversationId: branch, sha: 'abc1234def' },
    },
  })
const respond = (calls: { id: string; name: string; to?: string }[] = []) =>
  entry('pi.assistant', {
    model: [
      {
        role: 'assistant',
        stopReason: calls.length ? 'toolUse' : 'stop',
        content: calls.map(({ id, name, to }) => ({
          type: 'toolCall',
          id,
          name,
          arguments: { to },
        })),
      },
    ],
  } as unknown as Partial<EntryRecord>)
const result = (call: string, toolName: string, text = '') =>
  entry('pi.tool-result', {
    model: [
      {
        role: 'toolResult',
        toolCallId: call,
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
      },
    ],
  } as unknown as Partial<EntryRecord>)
const message = (m: Partial<Message> & Pick<Message, 'id' | 'from' | 'to'>): Message => ({
  text: '',
  at: 0,
  reply: false,
  state: 'delivered',
  ...m,
})

describe('threadsOf', () => {
  it('buckets three interleaving branches, their turns, the answers to their questions and a landing', () => {
    next = 1
    const entries = [
      prompt(), // 1: the user asks for three features
      respond([
        { id: 'b1', name: 'branch' },
        { id: 'b2', name: 'branch' },
        { id: 'b3', name: 'branch' },
      ]), // 2
      result('b1', 'branch', 'Branch #21 started; message 1 sent.'), // 3
      result('b2', 'branch', 'Branch #22 started; message 2 sent.'), // 4
      result('b3', 'branch', 'Branch #23 started; message 3 sent.'), // 5
      respond(), // 6: "started all three"
      fromBranch(22, 4, 'board.reply'), // 7: #22 reports
      respond([{ id: 'q', name: 'message', to: 'user' }]), // 8: asks the user about #22
      result('q', 'message'), // 9
      fromBranch(21, 6), // 10: #21 steps in between
      fromBranch(21, 7, 'board.message', false), // 11: and leaves a note
      respond([{ id: 'c', name: 'codemode' }]), // 12
      result('c', 'codemode'), // 13
      respond(), // 14
      fromBranch('user', 8), // 15: the user answers the question about #22
      respond([{ id: 'go', name: 'message', to: '#22' }]), // 16: relays the go
      result('go', 'message'), // 17
      landed(23), // 18
      respond(), // 19
      prompt(), // 20: something else entirely
      respond(), // 21
    ]
    const messages = [
      message({ id: 5, from: ULTIMATE, to: 'user', reply: true, call: 'q' }),
      message({ id: 8, from: 'user', to: ULTIMATE, re: 5 }),
      message({ id: 9, from: ULTIMATE, to: 22, call: 'go' }),
    ]
    const { of, threads } = threadsOf(entries, messages, ULTIMATE)
    const at = (id: number) => of.get(id) ?? []
    // Starting them: each call and result goes to its branch, the turn to all three.
    expect(at(1)).toEqual([21, 22, 23])
    expect(at(3)).toEqual([21])
    expect(at(6)).toEqual([21, 22, 23])
    // #22's report wakes a turn; the question asked in it, and the user's answer, are #22's.
    expect([7, 8, 9].map(at)).toEqual([[22], [22], [22]])
    expect(at(15)).toEqual([22])
    expect([16, 17].map(at)).toEqual([[22], [22]])
    // #21 interleaves: its message, note and the turn they wake are #21's alone.
    expect([10, 11, 12, 13, 14].map(at)).toEqual([[21], [21], [21], [21], [21]])
    // A landing and the turn it wakes.
    expect([18, 19].map(at)).toEqual([[23], [23]])
    expect(threads.find((thread) => thread.id === 23)?.landed).toEqual({
      entry: 18,
      sha: 'abc1234def',
    })
    // The user's unrelated prompt belongs to no thread.
    expect([20, 21].map(at)).toEqual([[], []])
    expect(threads.map((thread) => thread.id)).toEqual([21, 22, 23])
  })

  it('lays out lanes side by side, reusing a column once its thread ended', () => {
    const threads = new Map([
      [1, [21]],
      [2, [22]],
      [3, [21]],
      [4, [23]],
    ])
    const lanes = laneColumns(threads)
    expect(lanes.width).toBe(2)
    // #23 starts after #21 ended, so it takes #21's column.
    expect(lanes.column.get(23)).toBe(0)
    const part = (id: number) => ({ entry: { id } as EntryRecord })
    expect(laneAt(lanes, [part(2)], threads)).toEqual([
      { thread: 21, here: false, up: true, down: true },
      { thread: 22, here: true, up: false, down: false },
    ])
  })
})
