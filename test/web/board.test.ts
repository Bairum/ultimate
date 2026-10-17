import { describe, expect, it } from 'vitest'
import {
  parseAddress,
  relativeTime,
  suggestions,
  unreadCount,
} from '../../extensions/board/data.tsx'

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
