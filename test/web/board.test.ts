import { describe, expect, it } from 'vitest'
import { accentIndex, accentOf } from '../../extensions/board/accent.tsx'
import {
  answeredMessages,
  conversationState,
  stateWord,
  messageStatus,
  outgoingState,
  relativeTime,
  scriptMessaged,
  sentBy,
  sentStatus,
  ultimateChat,
  waitingOnUser,
} from '../../extensions/board/data.tsx'
import type { BoardMessage } from '../../extensions/board/refs.ts'

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
  it("counts @ultimate's asking final answer as one more", () => {
    expect(waitingOnUser({ messages, next: 9 }, true)).toBe(2)
    expect(waitingOnUser({ messages: [], next: 1 }, true)).toBe(1)
    expect(waitingOnUser({ messages: [], next: 1 }, false)).toBe(0)
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
    expect(ultimateChat({ ...ultimate, title: '@lander' })).toBe(false)
    expect(ultimateChat({ ...ultimate, parentConversationId: 4 })).toBe(false)
    expect(ultimateChat({ ...ultimate, ownerTaskId: 9 })).toBe(false)
    expect(ultimateChat({ ...ultimate, label: 'coordinator' })).toBe(false)
  })
})

const script = (id: string) => ({ id, name: 'codemode' })
describe('messages a codemode script sent', () => {
  const base = { from: 2, to: 'user' as const, text: 'Ship it?', at: 100, reply: true }
  // Identical texts from two scripts and a direct call, in different states, plus a message to a branch and one from
  // before the log recorded calls.
  const log: BoardMessage[] = [
    { ...base, id: 1, state: 'answered', call: 'a/1' },
    { ...base, id: 2, state: 'delivered', call: 'b/1' },
    { ...base, id: 3, state: 'delivered', call: 'a/3', reply: false },
    { ...base, id: 4, state: 'delivered', call: 'a' },
    { ...base, id: 5, state: 'sent', to: 4, call: 'a/4' },
    { ...base, id: 6, state: 'delivered', call: 'ab/1' },
    { ...base, id: 7, state: 'delivered' },
  ]
  it('binds each identical text to the call that sent it, in the order sent', () => {
    expect(sentBy(log, 'a').map((m) => [m.id, messageStatus(m)])).toEqual([
      [1, 'answered'],
      [3, 'one-way'],
      [4, 'yours'],
    ])
    expect(sentBy(log, 'b').map((m) => [m.id, messageStatus(m)])).toEqual([[2, 'yours']])
    expect(sentBy(log, 'c')).toEqual([])
  })
  it('keeps a script visible from the log alone, with or without a result', () => {
    expect(scriptMessaged(script('b'), { messages: log, next: 8 })).toBe(true)
    expect(scriptMessaged(script('c'), { messages: log, next: 8 })).toBe(false)
    expect(scriptMessaged({ id: 'b', name: 'bash' }, { messages: log, next: 8 })).toBe(false)
    expect(scriptMessaged(script('b'), undefined)).toBe(false)
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

/** A board of reply-expected questions from conversation 2 to the user, each overridable. */
const board = (...messages: Partial<BoardMessage>[]) => ({
  messages: messages.map((message, index) => ({
    id: index + 1,
    from: 2,
    to: 'user' as const,
    text: 'Question',
    at: 0,
    reply: true,
    state: 'delivered' as const,
    ...message,
  })),
  next: messages.length + 1,
})

describe('conversation state', () => {
  const primary = { id: 2, kind: 'primary' as const }
  const toUser = board({ from: 2, to: 'user' })

  it('is working while it runs or has input queued, before anything else', () => {
    expect(conversationState({ ...primary, busy: true }, toUser)).toBe('working')
    expect(conversationState({ ...primary, runState: 'working' }, toUser)).toBe('working')
    expect(conversationState({ ...primary, runState: 'queued' }, board())).toBe('working')
  })

  it('waits only for the primary agent with an open question to the user or an asking answer', () => {
    expect(conversationState({ ...primary, runState: 'answered' }, toUser)).toBe('waits')
    expect(conversationState({ ...primary, runState: 'answered' }, board(), true)).toBe('waits')
    expect(conversationState({ ...primary, runState: 'answered' }, board())).toBe('idle')
    expect(
      conversationState({ ...primary, runState: 'answered' }, board({ state: 'answered' })),
    ).toBe('idle')
  })

  it('never waits for a subagent or another conversation, even with open messages to the user', () => {
    for (const kind of ['subagent', 'other'] as const)
      expect(conversationState({ id: 2, kind, runState: 'answered' }, toUser, true)).not.toBe(
        'waits',
      )
  })

  it('awaits the primary agent while its reply-expected message to it is open', () => {
    const branch = { id: 5, kind: 'other' as const, runState: 'answered' as const, primary: 3 }
    for (const state of ['sent', 'delivered'] as const)
      expect(conversationState(branch, board({ from: 5, to: 3, state }))).toBe('awaiting')
    expect(conversationState(branch, board({ from: 5, to: 3, state: 'answered' }))).toBe('idle')
    expect(conversationState(branch, board({ from: 5, to: 3, reply: false }))).toBe('idle')
    // A coordinator's question to its own worker waits on no one the user watches.
    expect(conversationState(branch, board({ from: 5, to: 9 }))).toBe('idle')
    // A subagent's question goes to its parent, which answers it in its own run: it never shows as awaiting.
    expect(conversationState({ ...branch, kind: 'subagent' }, board({ from: 5, to: 3 }))).toBe(
      'done',
    )
  })

  it('says every state in a word, so a standing row or lane never falls back to idle', () => {
    // A standing agent (not the primary) asking @ultimate shows it, rather than idle.
    const standing = { id: 7, kind: 'other' as const, runState: 'answered' as const, primary: 3 }
    expect(stateWord(conversationState(standing, board({ from: 7, to: 3 })))).toBe(
      'awaiting @ultimate',
    )
    expect(stateWord('waits', 2)).toBe('2 waiting on you')
    expect(stateWord('failed')).toBe('failed')
    expect(stateWord('done')).toBe('done')
    expect(stateWord('idle')).toBe('idle')
  })

  it('failed when its latest input ended without an answer', () => {
    expect(conversationState({ id: 5, kind: 'other', runState: 'error' }, board())).toBe('failed')
  })

  it('done for an answered subagent, idle for any other answered conversation', () => {
    expect(conversationState({ id: 5, kind: 'subagent', runState: 'answered' }, board())).toBe(
      'done',
    )
    expect(conversationState({ id: 5, kind: 'other', runState: 'answered' }, board())).toBe('idle')
  })
})
