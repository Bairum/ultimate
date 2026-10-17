import { useDocOf } from '@/sdk'

type SideState = { ended?: 'note' | 'branch' | 'discard'; ending?: 'note' | 'branch' }

/** A side chat's state, as projects from before read-only tallies store it; contributions stop taking input once it ended. */
export function useSideState(id: number | undefined) {
  return useDocOf<{ side?: SideState }>(id, 'lineage.side')?.side
}
