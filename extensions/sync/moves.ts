import type { Transition } from '../../cloud/protocol.ts'

/** `done` once the claim is done, `failed` once an error is set, else undefined while it runs. */
export function ended(moved: Transition) {
  if (moved.error) return 'failed' as const
  return moved.steps.find((step) => step.name === 'claim')?.state === 'done'
    ? ('done' as const)
    : undefined
}

/**
 * Whether the move card keeps polling: until the transition with the started id has ended. An older transition still
 * shown before the target publishes the new one's first step keeps it polling too.
 */
export const polling = (started: string | undefined, transition: Transition | null | undefined) =>
  !!started && (transition?.id !== started || ended(transition) === undefined)
