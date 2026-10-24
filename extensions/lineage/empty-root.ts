/**
 * Whether a root is new to the project and starts with setup: no tally and no memories. A new chapter's root has
 * carried memories and no history yet: it is set up already.
 */
export const emptyRoot = (
  tally: { since?: number } | null,
  memories: { memories: Record<string, unknown> } | null,
) => tally?.since === undefined && !Object.keys(memories?.memories ?? {}).length
