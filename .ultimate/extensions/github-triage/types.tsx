export type Kind = 'issue' | 'pr'

export interface Label {
  name: string
  color: string
}

export interface Item {
  number: number
  title: string
  author: string
  labels: Label[]
  createdAt: string
  updatedAt: string
  draft: boolean
}

export interface Comment {
  id: string
  author: string
  body: string
  createdAt: string
}

export interface Detail {
  kind: Kind
  number: number
  title: string
  author: string
  labels: Label[]
  createdAt: string
  body: string
  url: string
  draft: boolean
  branch: { base: string; head: string } | null
  diff: { additions: number; deletions: number } | null
  comments: Comment[]
}

export type Shown = { status: 'ok'; item: Detail } | { status: 'error'; message: string }

export type Status =
  | { status: 'missing' }
  | { status: 'auth'; message: string }
  | { status: 'ready'; login: string; defaultRepo: string | null }

export type Listing = { status: 'ok'; items: Item[] } | { status: 'error'; message: string }

/** How long ago `iso` was, GitHub style: now, 5m, 3h, 2d, 4mo, 1y. */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, (now - Date.parse(iso)) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.floor(minutes)}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / 60 / 24)}d`
  if (minutes < 60 * 24 * 365) return `${Math.floor(minutes / 60 / 24 / 30)}mo`
  return `${Math.floor(minutes / 60 / 24 / 365)}y`
}

export const inputClass =
  'h-7 min-w-0 rounded-md border border-input bg-transparent px-2 text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'

/** Fired after the user applied labels or posted a reply, so the surface reloads what changed. */
export const changed = new EventTarget()

/** One half of a proposal as `server.ts` records it in the `github-triage.proposals` document. */
export type Outcome =
  | { state: 'pending'; at: string }
  | { state: 'applied'; at: string; labels: string[] }
  | { state: 'posted'; at: string; text: string; url: string }
  | { state: 'discarded'; at: string }
export type Outcomes = { [callId: string]: { labels?: Outcome; reply?: Outcome } }
