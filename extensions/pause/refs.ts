/** Pause in the browser: whether this Ultimate is paused, what still runs, and Pause and Play. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** The pause on conversation 1: `since` when it began, `runs` the conversations that were mid-turn then. */
export type PauseDocState = { paused: boolean; since?: number; runs?: number[] }

/** A task still running while paused: it finishes on its own, nothing new starts after it. */
export type RunningTask = {
  task: number
  conversationId: number
  /** The conversation's label or title. */
  title?: string
  /** `model response`, the tool's name, or the task kind. */
  what: string
  /** When the task first ran (ms). */
  startedAt?: number
}

export type PauseState = {
  paused: boolean
  since?: number
  /** Foreground tasks still running: while paused, the pause is safe once this is empty. */
  running: RunningTask[]
}

/** The pause, on conversation 1. */
export const PauseDoc = docRef<PauseDocState>('pause.state')
/** No arguments → the pause and the foreground tasks still running. */
export const StateAction = actionRef<null, PauseState>('pause', 'state')
/**
 * User-only: pause the whole host. Running tasks (a bash call, a model response) finish on their own; no task starts
 * after them, and inputs queue. Survives a restart. Returns the state.
 */
export const PauseAction = actionRef<null, PauseState>('pause', 'pause')
/** User-only: continue. Each run that was mid-turn when paused gets one "Paused for …" note. Returns the state. */
export const PlayAction = actionRef<null, PauseState>('pause', 'play')

/** The note Play leaves on a run that was mid-turn: paused from `since` to `until` (ms). */
export type PauseNote = { since: number; until: number }
