/** Draft review comments in durable UI state: kept across reloads and shared by every tab, per spec (`draftsKey`). */
import { useCallback } from 'react'
import type { JsonValue } from '@/sdk'
import { useExtensionUiState } from '@/sdk'
import type { ReviewComment } from './comments.ts'

/** A comment not sent yet; `id` tells drafts on the same lines apart. */
export type Draft = ReviewComment & { id: string }
/** A spec's pending review: its comments, the overall note, and the recipient the user picked, if any. */
export type Drafts = { comments: Draft[]; note: string; to?: number }

const empty: Drafts = { comments: [], note: '' }

/** The drafts under `key`, and an updater that stores them at once. */
export function useDrafts(key: string) {
  const [stored, set] = useExtensionUiState<JsonValue>(key, null)
  const drafts = (stored as Drafts | null) ?? empty
  const update = useCallback(
    (change: (drafts: Drafts) => Drafts) =>
      set((previous) => {
        const next = change((previous as Drafts | null) ?? empty)
        // An empty review leaves nothing behind but `null`.
        return !next.comments.length && !next.note && next.to === undefined ? null : next
      }),
    [set],
  )
  return [drafts, update] as const
}
