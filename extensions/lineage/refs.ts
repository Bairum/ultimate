/**
 * Lineage in the browser: the project's roots, each root's tally size, the actions behind a root's sidebar row and
 * landing cards, and the branch and root events. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { RootEvent } from './types.ts'

/** `{ roots }` on conversation 1: the project's roots, each the top of one conversation tree. */
export const RootsDoc = docRef<{ roots: number[] }>('lineage.roots')
/**
 * A root's tally bookkeeping on the root itself: `tokens`, the estimated size of its model-visible context, and
 * `since`, the entry it became a tally at (absent while it is an ordinary conversation).
 */
export const TallyDoc = docRef<{ tokens: number; since?: number }>('lineage.tally')

/**
 * `{ id, limit?, types? }` → the newest events of root `id` (landings, notes, branches, compactions), newest first:
 * `limit` defaults to 3, at most 20, only of `types` when given. Landings on a GitHub `origin` carry a compare link.
 */
export const RecentAction = actionRef<
  { id: number; limit?: number; types?: RootEvent['type'][] },
  RootEvent[]
>('lineage', 'recent')
/** `{ id, instructions? }` → `{ taskId }`: compact root `id`'s tally, as @ultimate's `compact_tally` does. */
export const CompactAction = actionRef<{ id: number; instructions?: string }, { taskId: number }>(
  'lineage',
  'compact',
)

/** A file that changed in a conversation's checkout since an entry: lines added and removed, or new and untracked. */
export type RewindFile = { path: string; added: number; removed: number; untracked?: true }
/** A conversation that built on the path a go-back set aside: a subagent or branch it started, or one it messaged. */
export type RewindDependent = { id: number; via: 'subagent' | 'branch' | 'message' }
/** What going back to an entry would set aside and leave in the checkout; `refused` says why it cannot now. */
export type RewindPreview = {
  refused?: string
  /** Entries after the point that leave the model's context. */
  steps: number
  files: RewindFile[]
  commits: { sha: string; subject: string }[]
  dependents: RewindDependent[]
  /** Whether a summary model can summarize the set-aside path. */
  summaryModel: boolean
}
/** `{ conversation, at }` → what going back to entry `at` of `conversation` sets aside, or why it cannot. */
export const RewindPreviewAction = actionRef<{ conversation: number; at: number }, RewindPreview>(
  'lineage',
  'rewindPreview',
)
/**
 * `{ conversation, at, summarize? }` → `{ entry }`: go back to entry `at` in place. Everything after it leaves the model's
 * context (still shown, folded), and one note entry says what changed in the checkout since, with a summary of the
 * set-aside path when `summarize`. Starts no turn. User-only.
 */
export const RewindAction = actionRef<
  { conversation: number; at: number; summarize?: boolean },
  { entry: number }
>('lineage', 'rewind')
/** `conversation` went back to entry `at`; `entry` is its note, `dependents` the conversations that built on the path. */
export const Rewound = defineEvent<{
  conversation: number
  at: number
  entry: number
  dependents: number[]
}>('lineage.rewound')

/**
 * A branch started: conversation `id` forked from `from` at entry `at`, its prompt `intent`. Emitted in the forking
 * commit, before the branch's first run; react to it to set up a new branch's own state.
 */
export const Branched = defineEvent<{ id: number; from: number; at: number; intent: string }>(
  'lineage.branched',
)
/** A root was created: conversation `id`, titled `intent`. Emitted in the creating commit. */
export const Rooted = defineEvent<{ id: number; intent: string }>('lineage.rooted')
