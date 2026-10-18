/**
 * Automations: scheduled agent prompts that run as durable tasks. Other extensions ask the scheduler when it fires next.
 */
import { defineApi } from '../../shared/extension-api.ts'

/** What other extensions may ask of the scheduler. */
export interface AutomationsService {
  /** When the next enabled automation fires (epoch ms), undefined when none; use it to stay awake for a due run. */
  nextDue(): Promise<number | undefined>
}
/** The scheduler of this host; `want` it, since automations may be disabled. */
export const AutomationsApi = defineApi<AutomationsService>()('automations')
