/** Draft review comments, per project and spec, in this browser's local storage: a reload keeps them. */
import { useCallback, useSyncExternalStore } from 'react'
import type { ReviewComment } from './comments.ts'

/** A comment not sent yet; `id` tells drafts on the same lines apart. */
export type Draft = ReviewComment & { id: string }
/** A spec's pending review: its comments, the overall note, and the recipient the user picked, if any. */
export type Drafts = { comments: Draft[]; note: string; to?: number }

export const draftsKey = (project: string, spec: string) =>
  `ultimate.review.drafts:${project}:${spec}`

const empty: Drafts = { comments: [], note: '' }
const listeners = new Set<() => void>()
// One parsed value per key, so `useSyncExternalStore` sees the same object until the key changes.
const cache = new Map<string, { raw: string | null; value: Drafts }>()

function read(key: string): Drafts {
  const raw = localStorage.getItem(key)
  const hit = cache.get(key)
  if (hit && hit.raw === raw) return hit.value
  let value = empty
  if (raw)
    try {
      const parsed = JSON.parse(raw) as Partial<Drafts>
      value = {
        comments: Array.isArray(parsed.comments) ? parsed.comments : [],
        note: typeof parsed.note === 'string' ? parsed.note : '',
        ...(typeof parsed.to === 'number' && { to: parsed.to }),
      }
    } catch {
      // A corrupt entry holds nothing worth keeping: start over.
      value = empty
    }
  cache.set(key, { raw, value })
  return value
}

function write(key: string, value: Drafts) {
  if (!value.comments.length && !value.note && value.to === undefined) localStorage.removeItem(key)
  else localStorage.setItem(key, JSON.stringify(value))
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  const storage = (event: StorageEvent) => event.key?.startsWith('ultimate.review.') && listener()
  addEventListener('storage', storage)
  return () => {
    listeners.delete(listener)
    removeEventListener('storage', storage)
  }
}

/** The drafts under `key`, and an updater that stores them at once (other tabs follow). */
export function useDrafts(key: string) {
  const drafts = useSyncExternalStore(subscribe, () => read(key))
  const update = useCallback(
    (change: (drafts: Drafts) => Drafts) => write(key, change(read(key))),
    [key],
  )
  return [drafts, update] as const
}
