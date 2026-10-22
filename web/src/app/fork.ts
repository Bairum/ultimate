import type { EntryRecord } from '@earendil-works/pi-durable'

/**
 * Whether the loaded rows of conversation `id` reach its fork point: its oldest own entry is loaded and the entry right
 * before it is its source's. A windowed stream's head marker (`head`) sits apart from the window, next to only its
 * newest entries, so it does not count as the entry before.
 */
export function reachedFork(loaded: readonly EntryRecord[], id: number | undefined, head?: number) {
  const rows = loaded.filter((entry) => entry.id !== head).toSorted((a, b) => a.id - b.id)
  const own = rows.findIndex((entry) => entry.conversationId === id)
  return own > 0 && rows[own - 1].conversationId !== id
}
