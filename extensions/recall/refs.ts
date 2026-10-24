/** Recall in the browser: which input is being checked. Browser-safe. */
import { docRef } from '../../shared/extension-api.ts'

export type RecallState = {
  pending?: number
  last?: number
  injected: Record<string, number>
}
/**
 * Recall's bookkeeping on @ultimate's conversation: `pending`, the input entry being checked now (its bubble shimmers);
 * `last`, the newest input checked; `injected`, the context tokens at which each memory was last recalled.
 */
export const RecallDoc = docRef<RecallState>('recall.state')
