/** Phases in the browser: what each working conversation is doing now, as a short label. Browser-safe. */
import { docRef } from '../../shared/extension-api.ts'
import type { PhaseState } from './types.ts'

/** Each busy conversation's classified phase and the classifier's confidence, on conversation 1. */
export const PhasesDoc = docRef<PhaseState>('ultimate.conversation-phases')
