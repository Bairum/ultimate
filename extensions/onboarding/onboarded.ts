/**
 * Whether onboarding ran for this project: it started for the root (`onboarding.starts`), or the root carries
 * memories, which only setup writes first; a new chapter's root starts without `onboarding.starts` but keeps them.
 */
export const onboarded = (
  started: number | undefined,
  memories: { memories: Record<string, unknown> } | null,
) => started !== undefined || Object.keys(memories?.memories ?? {}).length > 0
