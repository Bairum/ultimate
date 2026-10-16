import { getState, useDocOf } from '@/sdk'

type Roots = { roots: number[]; sides?: Record<string, number> }
/** Conversation 1 keeps the `lineage.roots` document. */
const keeper = 1
const kind = 'lineage.roots'

/** The project's roots, live in every client; undefined until the stream delivers them. */
export function useRoots() {
  return useDocOf<Roots>(keeper, kind)?.roots
}

/** Each root's open side chat, by root id; undefined until the stream delivers them. */
export function useSides() {
  const roots = useDocOf<Roots>(keeper, kind)
  return roots === undefined ? undefined : (roots?.sides ?? {})
}

/** The roots as last streamed, for synchronous readers such as a command's `when`; a mounted `useRoots` keeps them. */
export function getRoots() {
  return (getState().docsOf[keeper]?.[kind] as Roots | null | undefined)?.roots
}
