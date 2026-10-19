/**
 * The stream's rows as state, changed only by these pure steps, so no failure leaves it stuck and no row it shows
 * becomes unreachable. Without a `head` (before the first page, after a failure, after an overflow) the next tick
 * loads the newest page again; with one it follows from it.
 */
import type { SystemRow } from './refs.ts'

/** Rows kept while following live before the stream starts over from the newest page. */
export const KEEP = 1000

export type Feed = {
  rows: SystemRow[]
  /** Pages back past the last row; absent once nothing older is left. */
  next?: string
  /** Follows live from here; absent until the newest page loaded. */
  head?: string
  loading: boolean
  /** Whether the user loaded older pages: then nothing is trimmed, since trimmed rows could not be paged to again. */
  paged: boolean
  error?: string
}
type Page = { rows: SystemRow[]; next?: string; head: string }

export const empty: Feed = { rows: [], loading: true, paged: false }

/** Asking for a page: refused while another is on its way. */
export const asking = (feed: Feed): Feed => ({ ...feed, loading: true })

/** The newest page replaces everything. */
export const loaded = (_feed: Feed, page: Page): Feed => ({
  rows: page.rows,
  ...(page.next === undefined ? {} : { next: page.next }),
  head: page.head,
  loading: false,
  paged: false,
})

/**
 * Rows recorded since `from` go on top, if the feed still follows from there. Past `KEEP` rows without paging back,
 * the head is dropped, so the next tick starts over from the newest page rather than trimming rows `next` skips.
 */
export function followed(feed: Feed, from: string, page: Page): Feed {
  if (feed.head !== from) return { ...feed, loading: false }
  const rows = [...page.rows, ...feed.rows]
  const { error: _, ...rest } = feed
  if (rows.length > KEEP && !feed.paged) {
    const { head: _head, ...over } = rest
    return { ...over, rows, loading: false }
  }
  return { ...rest, rows, head: page.head, loading: false }
}

/** An older page goes at the end, if the feed still pages from `from`. */
export function older(feed: Feed, from: string, page: Omit<Page, 'head'>): Feed {
  if (feed.next !== from) return { ...feed, loading: false }
  const { next: _, error: _error, ...rest } = feed
  return {
    ...rest,
    rows: [...feed.rows, ...page.rows],
    ...(page.next === undefined ? {} : { next: page.next }),
    loading: false,
    paged: true,
  }
}

/** A request failed: the rows stay, loading ends, and the next tick or scroll asks again. */
export const failed = (feed: Feed, error: string): Feed => ({ ...feed, loading: false, error })
