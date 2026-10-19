import { useEffect, useSyncExternalStore } from 'react'
import { useExtensionUiState, useUltimate } from '@/sdk'

/** The spec on screen, in durable UI state: it survives reloads and follows every tab, as the surface does. */
export const useSpec = () => useExtensionUiState<string>('spec', 'uncommitted')

// A review someone asked for and the link has not shown yet: the page's `?review=` first, then `openReview` calls.
let requested = new URL(location.href).searchParams.get('review') || undefined
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Show the Review surface at `spec` (see `ReviewKind` in refs.ts). */
export function openReview(spec: string) {
  requested = spec
  for (const listener of listeners) listener()
}

/**
 * Mounted at the root: shows a requested review, and keeps `?review=<spec>` in the address while Review is on screen,
 * so the address can be shared. It replaces the history entry: switching surfaces adds none.
 */
export function ReviewLink() {
  const wanted = useSyncExternalStore(subscribe, () => requested)
  const [spec, setSpec] = useSpec()
  const { surface, showSurface } = useUltimate()
  useEffect(() => {
    if (wanted === undefined) return
    requested = undefined
    setSpec(wanted)
    showSurface('review')
  }, [wanted, setSpec, showSurface])
  useEffect(() => {
    if (requested !== undefined) return
    const url = new URL(location.href)
    const shown = surface === 'review' ? spec : null
    if (url.searchParams.get('review') === shown) return
    if (shown === null) url.searchParams.delete('review')
    else url.searchParams.set('review', shown)
    history.replaceState(history.state, '', url)
  }, [surface, spec])
  return null
}
