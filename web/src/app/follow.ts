/** Where the view was last placed, and where it is now. */
export interface ScrollPlace {
  /** The scroller's scrollTop now. */
  top: number
  /** scrollTop at the last scroll event this transcript saw. */
  seen: number
  /** The last scrollTop the follow library set itself, while no scroll event has reported it yet. */
  placed?: number
  /** Pixels between the view and the bottom now. */
  distance: number
}

/**
 * Whether the reader moved the view up away from the bottom. While following, the library only ever scrolls down and the
 * browser's anchoring is off, so an upward move is the reader's. It is measured from the highest place the view was
 * known to be: an animation step and the reader's scroll can arrive in one scroll event.
 */
export function readerLeft({ top, seen, placed, distance }: ScrollPlace): boolean {
  return top < Math.max(seen, placed ?? 0) - 1 && distance > 1
}
