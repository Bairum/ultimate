import { describe, expect, it } from 'vitest'
import {
  keyCard,
  newestAsked,
  openQuestions,
  replyQuestions,
} from '../../extensions/questions/open.tsx'

const question = { text: 'Keep the preview?', kind: 'confirm' as const }
const open = { id: 5, from: 2, to: 'user' as const, reply: true, state: 'delivered' as const }
const board = { requested: [5, 6, 7], asked: { '5': [question], '6': [question] } }
const answer = { id: 40, kind: 'pi.assistant' }

describe('message answer cards', () => {
  it('shows questions only while the message waits on the user', () => {
    expect(openQuestions(board, open)).toEqual([question])
    expect(openQuestions(board, { ...open, state: 'answered' })).toEqual([])
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
})

describe("@ultimate's final-answer card", () => {
  const asked = { ...board, reply: { conversation: 2, entry: 40, questions: [question] } }
  it('shows only under the current answer in its own conversation', () => {
    expect(replyQuestions(asked, 2, 40, [answer])).toEqual([question])
    expect(replyQuestions(asked, 2, 39, [answer])).toEqual([])
    expect(replyQuestions(asked, 3, 40, [answer])).toEqual([])
    expect(replyQuestions(board, 2, 40, [answer])).toEqual([])
  })
  it('disappears once a reset follows the answer', () => {
    expect(replyQuestions(asked, 2, 40, [answer, { id: 41, kind: 'pi.reset' }])).toEqual([])
    expect(keyCard(asked, 2, [], [answer, { id: 41, kind: 'pi.reset' }])).toBeUndefined()
  })
  it('disappears once any input follows the answer', () => {
    const later = [answer, { id: 41, kind: 'conversations.assessed' }]
    expect(replyQuestions(asked, 2, 40, later)).toEqual([question])
    expect(replyQuestions(asked, 2, 40, [...later, { id: 42, kind: 'pi.user' }])).toEqual([])
    expect(
      replyQuestions(asked, 2, 40, [...later, { id: 42, kind: 'board.message', input: true }]),
    ).toEqual([])
  })
  it('gives the keys to the answer card, else the newest open message this conversation sent', () => {
    const messages = [open, { ...open, id: 6 }, { ...open, id: 7, from: 3 }]
    expect(keyCard(asked, 2, messages, [answer])).toBe('reply:40')
    expect(keyCard(asked, 2, messages, [answer, { id: 41, kind: 'pi.user' }])).toBe('message:6')
    expect(keyCard(board, 3, messages, [])).toBeUndefined()
    expect(keyCard(board, 2, [open], [])).toBe('message:5')
    expect(keyCard(board, 2, [{ ...open, state: 'answered' }], [])).toBeUndefined()
  })
})
