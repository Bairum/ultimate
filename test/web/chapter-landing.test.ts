import { expect, it } from 'vitest'
import { emptyRoot } from '../../extensions/lineage/empty-root.ts'
import { landing } from '../../extensions/subagents/landing.ts'

// A new chapter opens with empty UI state and a root without history: the page showed root #1's Start here card,
// and its Set up button started onboarding in a project that was set up long ago.
it('opens @ultimate when no conversation is chosen, as on the first page of a new chapter', () => {
  expect(landing(true, undefined, { ultimate: 42 })).toBe(42)
  expect(landing(false, undefined, { ultimate: 42 })).toBeUndefined()
  expect(landing(true, undefined, undefined)).toBeUndefined()
  expect(landing(true, 1, { ultimate: 42 })).toBeUndefined()
})

// A fresh preview has no @ultimate conversation until something starts it: the page stayed on History #1.
it('starts @ultimate when a fresh home has none yet', () => {
  expect(landing(true, undefined, {})).toBe('create')
  expect(landing(true, undefined, null)).toBe('create')
})

it("treats a new chapter's root with carried memories as set up, not as an empty root", () => {
  const carried = { memories: { 'about-daniel': {} } }
  expect(emptyRoot({}, false, carried)).toBe(false)
  expect(emptyRoot(null, false, { memories: {} })).toBe(true)
  expect(emptyRoot({ since: 5 }, false, null)).toBe(false)
})
