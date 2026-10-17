import { createContext, useContext } from 'react'

export const ComposerContext = createContext<{
  /** Text-only draft access; clear preserves edits made after the snapshot. */
  draft?: {
    read(): { text: string; revision: number }
    clear(snapshot: { text: string; revision: number }): void
  }
}>({})

/** The composer owning this toolbar or status contribution. */
export function useComposer() {
  return useContext(ComposerContext)
}
