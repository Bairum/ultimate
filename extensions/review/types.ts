/** Review comments as they travel: from the surface's drafts to the `review.comments` input. Browser-safe. */

/** One comment on lines `start`–`end` of `file`, on the diff's `old` or `new` side, with those lines as `excerpt`. */
export type ReviewComment = {
  file: string
  side: 'old' | 'new'
  start: number
  end: number
  excerpt: string
  text: string
}

/** What a review carries into the recipient's transcript, as the data of its `review.comments` entry. */
export type ReviewComments = { spec: string; comments: ReviewComment[]; note?: string }
