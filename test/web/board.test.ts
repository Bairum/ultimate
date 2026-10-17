import { describe, expect, it } from 'vitest'
import {
  accentIndex,
  answeredMessages,
  messageStatus,
  parseAddress,
  participants,
  participantStatus,
  participantMessages,
  relativeTime,
  side,
  suggestions,
  unreadCount,
  waits,
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

/** The status of idle coordinator #4 next to `conversations`. */
const coordinatorStatus = (conversations: Parameters<typeof participants>[3]) =>
  participants({ messages: [], next: 1, readUpTo: 0 }, { agents: [], conversations: [] }, {}, [
    { id: 4, label: 'coordinator', busy: false },
    ...conversations,
  ]).find((item) => item.id === 4)?.status

describe('board roster', () => {
  const messages = [
    { id: 1, from: 4, to: 2, text: 'Decision?', at: 100, reply: true, state: 'delivered' as const },
    {
      id: 2,
      from: 2,
      to: 'user' as const,
      text: 'Hello',
      at: 200,
      reply: false,
      state: 'delivered' as const,
    },
  ]
  it('lists standing agents, the lander and active coordinators without duplicates or concluded branches', () => {
    const roster = participants(
      { messages, next: 3, readUpTo: 0 },
      {
        agents: [{ name: 'ultimate' }, { name: 'dice', id: 3 }].map((agent) => ({
          ...agent,
          description: '',
        })),
        lander: 7,
        conversations: [],
        concluded: [6],
      },
      { ultimate: 2 },
      [
        { id: 2, busy: false },
        { id: 4, label: 'coordinator', title: 'Build board', busy: false, answerAt: 150 },
        { id: 5, label: 'coordinator', busy: true },
        { id: 6, label: 'coordinator', busy: false },
        { id: 8, label: 'coordinator', parentConversationId: 5, busy: true },
        { id: 9, busy: false },
      ],
    )
    expect(roster.map((item) => item.key)).toEqual([
      'user',
      '@ultimate',
      '@dice',
      '@lander',
      '#4',
      '#5',
    ])
    expect(roster.find((item) => item.id === 4)).toMatchObject({
      name: 'Build board',
      status: 'waiting',
      at: 150,
    })
    expect(roster.find((item) => item.id === 5)?.status).toBe('working')
    expect(roster[0]).toMatchObject({ at: 200, status: 'idle' })
  })
  it('derives status from busy state and open reply requests, not closed or one-way messages', () => {
    expect(participantStatus(4, true, messages)).toBe('working')
    expect(participantStatus(4, true, messages, true)).toBe('working')
    expect(participantStatus(4, false, messages, true)).toBe('needs input')
    expect(participantStatus(4, false, messages)).toBe('waiting')
    expect(participantStatus(4, false, [{ ...messages[0], state: 'answered' }])).toBe('idle')
    expect(participantStatus(4, false, [{ ...messages[0], state: 'failed' }])).toBe('idle')
    expect(participantStatus(undefined, false, messages)).toBe('idle')
    expect(participantStatus(2, false, messages)).toBe('idle')
    expect(participantStatus(4, false, messages, true, true)).toBe('delegating')
    expect(participantStatus(4, true, messages, false, true)).toBe('working')
  })
  it('shows an idle coordinator as delegating while a subagent below it works, not a branch', () => {
    // A worker's own reviewer, two levels down, still counts.
    expect(
      coordinatorStatus([
        { id: 10, parentConversationId: 4, ownerTaskId: 1, busy: false },
        { id: 11, parentConversationId: 10, ownerTaskId: 2, busy: true },
      ]),
    ).toBe('delegating')
    expect(
      coordinatorStatus([{ id: 10, parentConversationId: 4, ownerTaskId: 1, busy: false }]),
    ).toBe('idle')
    // A fork of the coordinator is not one of its subagents.
    expect(coordinatorStatus([{ id: 12, parentConversationId: 4, busy: true }])).toBe('idle')
  })
  it('filters both directions without including unrelated messages', () => {
    expect(participantMessages(messages, 2)).toEqual(messages)
    expect(participantMessages(messages, 4)).toEqual([messages[0]])
    expect(participantMessages(messages, 'user')).toEqual([messages[1]])
    expect(participantMessages(messages, 9)).toEqual([])
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
  it('puts the perspective on the right, what it receives left and other traffic aside', () => {
    expect(messages.slice(0, 3).map((message) => side(message, 'user'))).toEqual([
      'left',
      'right',
      'aside',
    ])
    expect(messages.slice(0, 3).map((message) => side(message, 2))).toEqual([
      'right',
      'left',
      'right',
    ])
    expect(side(messages[2], 4)).toBe('left')
  })
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
    expect(messageStatus({ ...messages[5], kind: 'landing' })).toBe('landing')
  })
  it('counts open requests a participant sent and owes, and those with the user', () => {
    expect(waits(messages, 'user')).toEqual({ waiting: 2, owes: 1, onUser: 0, onIt: 0 })
    expect(waits(messages, 2)).toEqual({ waiting: 2, owes: 1, onUser: 1, onIt: 1 })
    expect(waits(messages, 4)).toEqual({ waiting: 0, owes: 2, onUser: 0, onIt: 1 })
    expect(waits(messages, 9)).toEqual({ waiting: 0, owes: 0, onUser: 0, onIt: 0 })
  })
  it('gives each sender a stable palette slot', () => {
    expect(accentIndex(2, 6)).toBe(accentIndex(2, 6))
    expect(new Set([2, 3, 4, 5, 6, 7].map((id) => accentIndex(id, 6))).size).toBe(6)
  })
})

describe('board addressing', () => {
  it('shows elapsed minutes, hours and days without future negative times', () => {
    expect(relativeTime(1000, 0)).toBe('now')
    expect(relativeTime(0, 60000)).toBe('1m')
    expect(relativeTime(0, 3600000)).toBe('1h')
    expect(relativeTime(0, 86400000)).toBe('1d')
  })
  it('uses a leading address, otherwise defaults only to an available Ultimate', () => {
    expect(parseAddress(' @dice roll 3d6 ', true)).toEqual({ to: '@dice', text: 'roll 3d6' })
    expect(parseAddress('#12 hello @dice', false)).toEqual({ to: '#12', text: 'hello @dice' })
    expect(parseAddress('hello @dice', true)).toEqual({ to: '@ultimate', text: 'hello @dice' })
    expect(parseAddress('hello', false)).toEqual({ to: '', text: 'hello' })
    expect(parseAddress('@dice', false)).toEqual({ to: '@dice', text: '' })
  })
  it('suggests agents, the lander and conversation titles at the caret', () => {
    const addresses = {
      agents: [{ name: 'dice', description: 'Roll dice' }],
      lander: 3,
      conversations: [{ id: 12, title: 'Build board' }],
    }
    expect(suggestions('@di', 3, addresses)).toEqual([
      { token: '@dice', detail: 'Roll dice', start: 0 },
    ])
    expect(suggestions('@la', 3, addresses)[0]?.token).toBe('@lander')
    expect(suggestions('hello #bo', 9, addresses)[0]).toEqual({
      token: '#12',
      detail: 'Build board',
      start: 6,
    })
    expect(suggestions('email@dice', 10, addresses)).toEqual([])
  })
  it('counts only inbox items after the read mark', () => {
    const message = {
      from: 2 as const,
      to: 'user' as const,
      text: 'hello',
      at: 0,
      reply: false,
      state: 'delivered' as const,
    }
    expect(
      unreadCount({
        messages: [
          { ...message, id: 1 },
          { ...message, id: 2 },
          { ...message, id: 3, to: 4 },
        ],
        next: 4,
        readUpTo: 1,
      }),
    ).toBe(1)
  })
})
