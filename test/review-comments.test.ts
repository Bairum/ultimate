import { expect, it } from 'vitest'
import {
  checkReview,
  code,
  draftsKey,
  excerptOf,
  languageOf,
  limits,
  reviewText,
} from '../extensions/review/comments.ts'

const bytes = (text: string) => new TextEncoder().encode(text).length

it('fences excerpts so their backticks cannot close the fence, with a language from the path', () => {
  const text = reviewText({
    spec: 'main...feature',
    comments: [
      {
        file: 'docs/a.md',
        side: 'new',
        start: 1,
        end: 2,
        excerpt: '```ts\nx\n```',
        text: ' Fix. ',
      },
      { file: 'Makefile', side: 'old', start: 9, end: 9, excerpt: '', text: 'Gone?' },
    ],
  })
  expect(text).toBe(
    [
      'Review of `main...feature` (2 comments)',
      '`docs/a.md:1-2` (new)\n````md\n```ts\nx\n```\n````\nFix.',
      '`Makefile:9` (old)\nGone?',
    ].join('\n\n'),
  )
  expect(languageOf('web/App.TSX')).toBe('tsx')
  expect(languageOf('.env')).toBe('')
})

it('keeps a file name with backticks and a newline on its own line, inside one code span', () => {
  const file = 'odd ``name`\nsecond.ts'
  const place = reviewText({
    spec: 'x',
    comments: [{ file, side: 'new', start: 2, end: 2, excerpt: '', text: 'Rename.' }],
  }).split('\n\n')[1]
  expect(place).toBe('```odd ``name`\\nsecond.ts:2``` (new)\nRename.')
  expect(code('`edge`')).toBe('`` `edge` ``')
  expect(code('tab\there')).toBe('`tab\\there`')
})

it('caps excerpts by lines and by UTF-8 bytes, at whole lines or within one huge line', () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`)
  expect(excerptOf(lines).split('\n')).toHaveLength(limits.excerptLines)
  // 30 lines of 150 × `é€` (2 + 3 bytes): 750 bytes each, so ten whole lines and their newlines fit in 8 KB.
  const wide = Array.from({ length: 30 }, () => 'é€'.repeat(150))
  const capped = excerptOf(wide)
  expect(capped.split('\n')).toHaveLength(10)
  expect(bytes(capped)).toBeLessThanOrEqual(limits.excerptBytes)
  const huge = excerptOf(['€'.repeat(5000)])
  expect(bytes(huge)).toBeLessThanOrEqual(limits.excerptBytes)
  expect(huge).toBe('€'.repeat(Math.floor(limits.excerptBytes / 3)))
  // What it quotes always passes the check.
  for (const excerpt of [capped, huge])
    expect(() =>
      checkReview({
        spec: 'x',
        comments: [{ file: 'a', side: 'new', start: 1, end: 1, excerpt, text: 'ok' }],
      }),
    ).not.toThrow()
})

it('drops a blank note and refuses a review without a spec', () => {
  const review = checkReview({
    spec: 'x',
    note: '  ',
    comments: [{ file: 'a', side: 'new', start: 1, end: 1, excerpt: '', text: 'ok' }],
  })
  expect(review).not.toHaveProperty('note')
  expect(() => checkReview({ spec: '', comments: [] })).toThrow('spec')
})

/** What the server accepts as a UI state key (server/api.ts `validUiKey`), with the `ext.review.` prefix. */
const valid = (key: string) => `ext.review.${key}`.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key)

it('keeps drafts apart per spec and per worktree, in keys UI state accepts', () => {
  const keys = [
    draftsKey('uncommitted'),
    draftsKey('uncommitted', 12),
    draftsKey('uncommitted', 13),
    draftsKey('branch:ultimate/a-1'),
    draftsKey('branch:ultimate/a_1'),
    draftsKey('a...b'),
    draftsKey(`${'f'.repeat(40)}...${'e'.repeat(40)}`),
    draftsKey(`${'f'.repeat(40)}...${'d'.repeat(40)}`),
  ]
  expect(new Set(keys).size).toBe(keys.length)
  for (const key of [...keys, draftsKey('x'.repeat(500)), draftsKey('ü / weird`spec')])
    expect(valid(key)).toBe(true)
})
