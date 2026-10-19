import { expect, it } from 'vitest'
import { checkReview, excerptOf, languageOf, reviewText } from '../extensions/review/comments.ts'
import { draftsKey } from '../extensions/review/drafts.ts'

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

it('caps excerpts at 40 lines and drops a blank note', () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`)
  expect(excerptOf(lines).split('\n')).toHaveLength(40)
  const review = checkReview({
    spec: 'x',
    note: '  ',
    comments: [{ file: 'a', side: 'new', start: 1, end: 1, excerpt: excerptOf(lines), text: 'ok' }],
  })
  expect(review).not.toHaveProperty('note')
  expect(() => checkReview({ spec: '', comments: [] })).toThrow('spec')
})

it('keeps drafts per spec and project', () => {
  expect(draftsKey('/p', 'uncommitted')).toBe('ultimate.review.drafts:/p:uncommitted')
  expect(draftsKey('/p', 'a...b')).not.toBe(draftsKey('/q', 'a...b'))
})
