/**
 * Whether a root is new to the project and starts with setup: no tally, no history and no memories. A new chapter's
 * root has carried memories and no history yet: it is set up already.
 */
export const emptyRoot = (
  tally: { since?: number } | null,
  history: boolean,
  memories: { memories: Record<string, unknown> } | null,
) => tally?.since === undefined && !history && !Object.keys(memories?.memories ?? {}).length
