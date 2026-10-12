import { defineDoc } from '@earendil-works/pi-durable'
import type { TaskId } from '@earendil-works/pi-durable'
import type { CanvasState, Conclusion } from './types.ts'

/** `ultimate.canvas` on the root conversation; version 2 added `trees`. */
export const Canvas = defineDoc<CanvasState>({
  kind: 'ultimate.canvas',
  version: 2,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {}, trees: {} }),
  migrate: (value) => ({ ...(value as Pick<CanvasState, 'agents'>), trees: {} }),
  // Streaming rewrites a few fields several times a second; store a complete base now and then.
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 200,
})

export type ConclusionState = {
  /** The task concluding the tree's current settled state; activity or a decision clears it. */
  pending?: TaskId
  conclusion?: Conclusion
}
/** A top-level conversation's latest conclusion, with its thumbnail; the canvas fetches it through an action. */
export const Conclusions = defineDoc<ConclusionState>({
  kind: 'ultimate.canvas-conclusion',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
