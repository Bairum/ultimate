import { expect, it } from 'vitest'
import { readerLeft } from '../../web/src/app/follow.ts'

it('counts an upward move away from the bottom as the reader leaving', () => {
  expect(readerLeft({ top: 800, seen: 1000, distance: 200 })).toBe(true)
})

it('ignores the follow moving down and a view that is still at the bottom', () => {
  expect(readerLeft({ top: 1100, seen: 1000, distance: 40 })).toBe(false)
  // Content shrank and the view was clamped to the new bottom.
  expect(readerLeft({ top: 900, seen: 1000, distance: 1 })).toBe(false)
})

it('sees the reader scroll back when an animation step and the scroll arrive in one event', () => {
  // The follow placed the view at 1,100; the reader scrolled to 1,060 before a scroll event reported either.
  expect(readerLeft({ top: 1060, seen: 1000, placed: 1100, distance: 60 })).toBe(true)
  // Without the reader, that event reports the follow's own placement.
  expect(readerLeft({ top: 1100, seen: 1000, placed: 1100, distance: 20 })).toBe(false)
})
