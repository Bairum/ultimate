import { describe, expect, it } from 'vitest'
import { accentIndex, accentOf } from '../../extensions/board/accent.tsx'
import {
  answeredMessages,
  messageStatus,
  outgoingState,
  relativeTime,
  scriptMessage,
  scriptMessages,
  sentStatus,
  ultimateChat,
  waitingOnUser,
} from '../../extensions/board/data.tsx'
import type { BoardMessage } from '../../extensions/board/data.tsx'

describe('board answer labels', () => {
  const request = {
    id: 1,
    from: 'user' as const,
    to: 2,
    text: 'Question',
    at: 0,
    reply: true,
    state: 'answered' as const,
    answer: 10,
  }
  it('selects a reply-enabled request for the answering entry', () => {
    expect(answeredMessages([request], 2, 10)).toEqual([request])
  })
  it('includes one-way deliveries without requiring the answered state', () => {
    const oneWay = { ...request, from: 4, reply: false, state: 'delivered' as const }
    expect(answeredMessages([oneWay], 2, 10)).toEqual([oneWay])
  })
  it('ignores other answers, conversations and requests with no answer', () => {
    expect(
      answeredMessages(
        [
          { ...request, answer: 11 },
          { ...request, to: 3 },
          { ...request, answer: undefined },
        ],
        2,
        10,
      ),
    ).toEqual([])
  })
  it('keeps every matching request in log order, excluding outgoing replies', () => {
    const second = { ...request, id: 2, from: 4, reply: false }
    expect(answeredMessages([request, second, { ...request, id: 3, to: 'user' }], 2, 10)).toEqual([
      request,
      second,
    ])
  })
})

describe('board chat', () => {
  const base = { text: '', at: 0, reply: true, state: 'delivered' as const }
  // #2 is @ultimate, #4 a branch it started.
  const messages: BoardMessage[] = [
    { ...base, id: 1, from: 2, to: 'user' }, // @ultimate asks the user
    { ...base, id: 2, from: 'user', to: 2 }, // the user asks @ultimate
    { ...base, id: 3, from: 2, to: 4 }, // @ultimate asks the branch
    { ...base, id: 4, from: 2, to: 4, state: 'answered' },
    { ...base, id: 5, from: 4, to: 2, reply: false, re: 4 }, // the branch's answer
    { ...base, id: 6, from: 2, to: 'user', reply: false }, // one-way update
    { ...base, id: 7, from: 'user', to: 4, state: 'sent' },
    { ...base, id: 8, from: 2, to: 4, state: 'failed' },
  ]
  it('says who waits: open questions to the user apart from other open requests', () => {
    expect(messages.map(messageStatus)).toEqual([
      'yours',
      'waiting',
      'waiting',
      'answered',
      'reply',
      'one-way',
      'waiting',
      'failed',
    ])
    expect(messageStatus({ ...messages[5], state: 'sent' })).toBe('sending')
  })
  it('counts only open reply-enabled questions to the user', () => {
    // #1 is open; the one-way update, the answered and sending ones and those to others do not wait on the user.
    expect(
      waitingOnUser({
        messages: [
          ...messages,
          { ...base, id: 9, from: 2, to: 'user', state: 'answered' },
          { ...base, id: 10, from: 2, to: 'user', state: 'sent' },
        ],
        next: 11,
      }),
    ).toBe(1)
    expect(waitingOnUser({ messages: [], next: 1 })).toBe(0)
  })
  it("counts @ultimate's asking final answer as one more, whatever its number of questions", () => {
    const reply = { conversation: 2, entry: 7, questions: [{}, {}] }
    expect(waitingOnUser({ messages, next: 9 }, { reply })).toBe(2)
    expect(waitingOnUser({ messages: [], next: 1 }, { reply })).toBe(1)
    expect(waitingOnUser({ messages: [], next: 1 }, {})).toBe(0)
    expect(waitingOnUser({ messages: [], next: 1 }, null)).toBe(0)
  })
  it('shows elapsed minutes, hours and days without future negative times', () => {
    expect(relativeTime(1000, 0)).toBe('now')
    expect(relativeTime(0, 60000)).toBe('1m')
    expect(relativeTime(0, 3600000)).toBe('1h')
    expect(relativeTime(0, 86400000)).toBe('1d')
  })
})

describe('sender accents', () => {
  it('gives each sender a stable palette slot', () => {
    expect(accentIndex(2, 6)).toBe(accentIndex(2, 6))
    expect(new Set([2, 3, 4, 5, 6, 7].map((id) => accentIndex(id, 6))).size).toBe(6)
  })
  it('gives the user the brand colour and conversations a palette colour, the same one every time', () => {
    expect(accentOf('user')).toEqual({
      left: 'border-l-brand/60',
      right: 'border-r-brand/60',
      fill: 'bg-brand/5',
      name: 'text-brand',
    })
    expect(accentOf(97078)).toBe(accentOf(97078))
    const conversations = [2, 3, 4, 5, 6, 7].map(accentOf)
    expect(new Set(conversations).size).toBe(6)
    expect(conversations.map((accent) => accent.name)).not.toContain('text-brand')
  })
})

describe('the @ultimate chat', () => {
  const ultimate = { label: 'agent', title: '@ultimate' }
  it("is @ultimate's own top-level standing conversation", () => {
    expect(ultimateChat(ultimate)).toBe(true)
  })
  it('excludes other standing agents, subagents and coordinators', () => {
    expect(ultimateChat({ ...ultimate, title: '@cloudflare' })).toBe(false)
    expect(ultimateChat({ ...ultimate, parentConversationId: 4 })).toBe(false)
    expect(ultimateChat({ ...ultimate, ownerTaskId: 9 })).toBe(false)
    expect(ultimateChat({ ...ultimate, label: 'coordinator' })).toBe(false)
  })
})

const nested = (name: string, args: object, status = 'ok') => ({ name, args, status, ms: 1 })
describe('messages a codemode script sent', () => {
  it('reads the texts of its finished message calls to you', () => {
    expect(
      scriptMessages({
        calls: [
          nested('read', { path: 'a' }),
          nested('message', { to: 'user', text: 'Ship it?', reply: true }),
          nested('message', { to: '#4', text: 'To a branch' }),
          nested('message', { to: 'user', text: 'Refused' }, 'error'),
          nested('message', { to: 'user', text: 'One-way', reply: false }),
        ],
      }),
    ).toEqual(['Ship it?', 'One-way'])
    expect(scriptMessages(undefined)).toEqual([])
    expect(scriptMessages({ calls: 'streamed' })).toEqual([])
  })
  const base = { to: 'user' as const, reply: true, state: 'delivered' as const }
  const log: BoardMessage[] = [
    { ...base, id: 1, from: 2, text: 'Ship it?', at: 100 },
    { ...base, id: 2, from: 3, text: 'Ship it?', at: 150 },
    { ...base, id: 3, from: 2, text: 'Ship it?', at: 200 },
    { ...base, id: 4, from: 2, to: 4, text: 'Other', at: 210 },
  ]
  it('finds the newest matching log message the script sent before its result', () => {
    expect(scriptMessage(log, 2, 'Ship it?', 120)?.id).toBe(1)
    expect(scriptMessage(log, 2, 'Ship it?', 250)?.id).toBe(3)
    expect(scriptMessage(log, 2, 'Ship it?')?.id).toBe(3)
    expect(scriptMessage(log, 2, 'Other')).toBeUndefined()
    // The bounded log dropped it.
    expect(scriptMessage(log, 2, 'Ship it?', 50)).toBeUndefined()
  })
})

describe('a sent message the log no longer holds', () => {
  const message: BoardMessage = {
    id: 1,
    from: 2,
    to: 'user',
    text: 'Ship it?',
    at: 0,
    reply: true,
    state: 'delivered',
  }
  it('reads as sending only while its call runs, then shows no state', () => {
    expect(sentStatus(undefined, true)).toBe('sending')
    expect(sentStatus(undefined, false)).toBeUndefined()
    expect(sentStatus(message, false)).toBe('yours')
    expect(outgoingState(undefined, true, true)).toBe('sending')
    expect(outgoingState(undefined, true, false)).toBeUndefined()
    expect(outgoingState(message, true, false)).toBe('awaiting your reply')
    expect(outgoingState({ ...message, reply: false }, true, false)).toBe('delivered')
  })
})
