/** Recall in the browser: which input is being checked. Browser-safe. */
import { docRef } from '../../shared/extension-api.ts'

export type RecallState = {
  pending?: number
  last?: number
}
/**
 * Recall's bookkeeping on @ultimate's conversation: `pending`, the input entry being checked now (its bubble shimmers);
 * `last`, the newest input checked.
 */
export const RecallDoc = docRef<RecallState>('recall.state')
