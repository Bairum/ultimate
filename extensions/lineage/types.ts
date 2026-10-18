/** One thing that happened in a root, newest first from the `recent` action, as its sidebar row lists it. */
export type RootEvent = {
  /** The root's entry it happened at. */
  entry: number
  at?: number
} & (
  | { type: 'landed'; sha: string; subject?: string; from?: number }
  | { type: 'note'; from?: number; text: string }
  | { type: 'branched'; branch: number; intent: string }
  | { type: 'compacted' }
  | { type: 'started' }
)
