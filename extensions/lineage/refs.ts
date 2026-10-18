/**
 * Lineage in the browser: the project's roots, each root's tally size, and the actions behind a root's sidebar row
 * and landing cards. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
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
/** No arguments → `https://github.com/<owner>/<repo>` of the project's `origin`, or null off GitHub. */
export const GithubAction = actionRef<null, string | null>('lineage', 'github')
/** `{ id, instructions? }` → `{ taskId }`: compact root `id`'s tally, as @ultimate's `compact_tally` does. */
export const CompactAction = actionRef<{ id: number; instructions?: string }, { taskId: number }>(
  'lineage',
  'compact',
)
