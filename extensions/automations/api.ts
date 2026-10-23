/** Automations: resume, pause, run and inspect scheduled or supervised script triggers. */
import { defineApi } from '../../shared/extension-api.ts'
import type { AutomationListItem } from './types.ts'
export type AutomationsService = {
  /** Resume a trigger from its current settings/executable. Commits; call outside transactions. */
  resume(id: string): Promise<AutomationListItem>
  /** Pause a trigger and terminate its script process group. Commits. */
  pause(id: string): Promise<AutomationListItem>
  /** Fire a schedule now, or relaunch a script. Commits. */
  run(id: string): Promise<AutomationListItem>
  /** The record, including whether its script process is alive. */
  status(id: string): Promise<AutomationListItem>
}
/** Optional automation service. */
export const AutomationsApi = defineApi<AutomationsService>()('automations')
export { Fired, Started, Exited, Done, Escalated } from './refs.ts'
