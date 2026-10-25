/** Automations: resume, pause, run and inspect scheduled, event, context or supervised script triggers. */
import type { Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Automation, AutomationListItem, CreateArgs, GrantedBy } from './types.ts'
export type { GrantedBy } from './types.ts'
export type AutomationsService = {
  /** Create an automation as the tool's create does; `subscribers` stand in for a caller. Commits. */
  create(args: CreateArgs): Promise<Automation>
  /** Delete a record, retiring its scheduler; files and conversations remain. Commits. */
  delete(id: string): Promise<void>
  /** Resume a trigger from its current settings/executable. Commits; call outside transactions. */
  resume(id: string): Promise<AutomationListItem>
  /** Pause a trigger and terminate its script process group. Commits. */
  pause(id: string): Promise<AutomationListItem>
  /** Fire a schedule, event or condition now, or relaunch a script. Commits. */
  run(id: string): Promise<AutomationListItem>
  /** The record, including whether its script process is alive. */
  status(id: string): Promise<AutomationListItem>
  /**
   * The record of `id` as `tx` sees it, a plain copy, or undefined once deleted: for a check (enabled, granted) that must
   * hold in the same transaction as the effect it allows.
   */
  read(tx: Tx, id: string): Promise<Automation | undefined>
}
/** Optional automation service. */
export const AutomationsApi = defineApi<AutomationsService>()('automations')
export type DreamGrantService = {
  /**
   * Inside `tx`, start a dream session exactly as the user's Dream button does, every refusal included, on a granted
   * fire; the `acting` conversation's own turn does not count as work in progress.
   */
  start(tx: Tx, by: GrantedBy, acting: number): Promise<{ session: number }>
  /**
   * Inside `tx`, admit a granted Fall asleep for `session` (default: the newest one with a filed journal): it checks the
   * session and reserves it, and a durable task waits until no conversation works, then runs every gate of the user's
   * Fall asleep (seed, scratch preview, one repair, backup, rollback on a failed restart). The switch records `by`, and
   * the morning card names it.
   */
  asleep(tx: Tx, by: GrantedBy, input: { session?: number }): Promise<{ session: number }>
}
/** The extension point through which a granted automation starts a dream or falls asleep; dream provides it. */
export const DreamGrant = defineApi<DreamGrantService>()('automations.dream')
export { Fired, Started, Exited, Done, Escalated } from './refs.ts'
