/** Prompt in the browser: the note on an input that says what changed since the conversation's last run. Browser-safe. */

/** A `prompt.build` entry's data: a build change, and the instruction files that changed for the primary agent. */
export interface BuildNote {
  from?: string
  to?: string
  /** Agent definitions whose instructions were re-applied. */
  instructions?: string[]
  /** Project context files and Ultimate's docs that changed. */
  docs?: string[]
}
