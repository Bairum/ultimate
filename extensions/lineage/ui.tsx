/** Lineage for other extensions' browser code: the project's roots, a root's tally, landing links and compaction. */
import { getState, useDocOf } from '@/sdk'
import { RootsDoc } from './refs.ts'

export { CompactAction, GithubAction, RecentAction, RootsDoc, TallyDoc } from './refs.ts'

/** Conversation 1 keeps the `lineage.roots` document. */
const keeper = 1

/** The project's roots, live in every client; undefined until the stream delivers them. */
export function useRoots() {
  return useDocOf(keeper, RootsDoc)?.roots
}

/** The roots as last streamed, for synchronous readers such as a command's `when`; a mounted `useRoots` keeps them. */
export function getRoots() {
  return (getState().docsOf[keeper]?.[RootsDoc.kind] as { roots: number[] } | null | undefined)
    ?.roots
}
