import type { UpdateState } from './refs.ts'

/**
 * Which status-line item the clone's state shows: none for a preview, `behind` with new commits, `install` or
 * `restart` while one is owed, else the quiet `current`.
 */
export function itemOf(state: UpdateState): 'none' | 'current' | 'behind' | 'install' | 'restart' {
  if (state.preview) return 'none'
  if (state.behind) return 'behind'
  if (state.install) return 'install'
  const updated = state.updated
  // Another Ultimate on the clone may have updated it: `restart` and `install` come from the clone, not this server.
  if (
    state.restart ||
    (updated && (updated.layers.core || updated.layers.lockfile || updated.layers.bin))
  )
    return 'restart'
  return 'current'
}
