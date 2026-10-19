import { describe, expect, it } from 'vitest'
import { keyCard, newestAsked, openQuestions, waiting } from '../../extensions/questions/open.tsx'

const question = { text: 'Keep the preview?', kind: 'confirm' as const }
const open = { id: 5, from: 2, to: 'user' as const, reply: true, state: 'delivered' as const }
const board = { requested: [5, 6, 7], asked: { '5': [question], '6': [question] } }

describe('message answer cards', () => {
  it('shows questions only while the message waits on the user', () => {
    expect(openQuestions(board, open)).toEqual([question])
    expect(openQuestions(board, { ...open, state: 'answered' })).toEqual([])
    expect(openQuestions(board, { ...open, state: 'dismissed' })).toEqual([])
    expect(openQuestions(board, { ...open, state: 'sent' })).toEqual([])
    expect(openQuestions(board, { ...open, reply: false })).toEqual([])
    expect(openQuestions(board, { ...open, to: 3 })).toEqual([])
    expect(openQuestions(board, { ...open, id: 7 })).toEqual([])
    expect(openQuestions(undefined, open)).toEqual([])
  })
  it('finds the newest message with an open card', () => {
    const later = { ...open, id: 6 }
    expect(newestAsked(board, [open, later, { ...open, id: 7 }])).toBe(6)
    expect(newestAsked(board, [open, { ...later, state: 'answered' }])).toBe(5)
    expect(newestAsked(board, [{ ...open, state: 'answered' }])).toBeUndefined()
  })
  it('gives the keys to the newest open message the shown conversation sent', () => {
    const messages = [open, { ...open, id: 6 }, { ...open, id: 7, from: 3 }]
    expect(keyCard(board, 2, messages)).toBe('message:6')
    expect(keyCard(board, 3, messages)).toBeUndefined()
    expect(keyCard(board, 2, [{ ...open, state: 'answered' }])).toBeUndefined()
  })
})

describe('the Questions panel', () => {
  it('lists every question still waiting on the user, newest first, until answered or dismissed', () => {
    const messages = [
      open,
      { ...open, id: 6, state: 'answered' as const },
      { ...open, id: 7, state: 'dismissed' as const },
      { ...open, id: 8, reply: false },
      { ...open, id: 9, to: 3 },
      { ...open, id: 10 },
    ]
    expect(waiting(messages).map((message) => message.id)).toEqual([10, 5])
  })
})
