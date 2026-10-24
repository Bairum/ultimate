/** Automations: durable triggers, actions, runs and script lifecycle events. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type {
  Automation,
  AutomationListItem,
  CreateArgs,
  GrantAction,
  Run,
  Schedule,
  TriggerEvent,
} from './types.ts'
export type {
  Automation,
  AutomationListItem,
  CreateArgs,
  Grant,
  GrantAction,
  GrantedBy,
  Run,
  Schedule,
  TriggerEvent,
} from './types.ts'
export type Described = { schedule: Schedule; description: string; next: number[] }
type Id = { id: string }
/** Available domain event triggers and filter fields. */
export const EventsAction = actionRef<null, TriggerEvent[]>('automations', 'events')
/** No arguments → all automations, with process-local alive. */
export const ListAction = actionRef<null, AutomationListItem[]>('automations', 'list')
/** Flat trigger and action arguments → new automation. */
export const CreateAction = actionRef<CreateArgs, Automation>('automations', 'create')
/** Update trigger settings and run profile; an empty agent copies the root agent. */
export const UpdateAction = actionRef<
  Id & Partial<Omit<CreateArgs, 'scope' | 'slug' | 'subscribers'>>,
  Automation
>('automations', 'update')
/** Pause a trigger, terminating its script process group if present. */
export const PauseAction = actionRef<Id, Automation>('automations', 'pause')
/** Resume a trigger; scripts require an executable run file. */
export const ResumeAction = actionRef<Id, Automation>('automations', 'resume')
/** Fire a schedule, event or condition now, or relaunch a script. */
export const RunAction = actionRef<Id, Run | Automation | Id>('automations', 'run')
/** Delete a record; files and conversations remain. */
export const DeleteAction = actionRef<Id, Id>('automations', 'delete')
/** Parse a schedule and describe its next fire times. */
export const DescribeAction = actionRef<{ schedule: string | Schedule }, Described>(
  'automations',
  'describe',
)
/** Subscribe #id or @name; default caller. */
export const SubscribeAction = actionRef<Id & { to?: string }, Automation>(
  'automations',
  'subscribe',
)
/** Remove a subscriber; default caller. */
export const UnsubscribeAction = actionRef<Id & { to?: string }, Automation>(
  'automations',
  'unsubscribe',
)
/** Last output.log lines, default 50 and maximum 2000. */
export const LogAction = actionRef<Id & { lines?: number }, { text: string }>('automations', 'log')
/** Executable path and first 64 KiB of text; empty while unwritten. */
export const ScriptAction = actionRef<Id, { path: string; text: string }>('automations', 'script')
/** Fail a script, notifying subscribers and @ultimate. */
export const EscalateAction = actionRef<Id & { reason: string }, Automation>(
  'automations',
  'escalate',
)
/**
 * `{ id, actions, source? }` → the automation: set the user's grant, the things its woken agent may do on a fire
 * without asking (`dream`, `compact`, `asleep`); empty `actions` withdraws it. User-only: no agent can grant itself.
 */
export const GrantRef = actionRef<Id & { actions: GrantAction[]; source?: string }, Automation>(
  'automations',
  'grant',
)
/** A granted automation acted for the user: `action` on its fire `fire`, by conversation `by`. */
export const Acted = defineEvent<{ id: string; action: string; fire: number; by: number }>(
  'automations.acted',
)
/** A trigger fired; fire is its lifetime count. */
export const Fired = defineEvent<{ id: string; text: string; fire: number }>('automations.fired')
/** Supervised executable started. */
export const Started = defineEvent<{ id: string; pid: number }>('automations.started')
/** Executable exited; null code means a signal or spawn error. */
export const Exited = defineEvent<{ id: string; code: number | null; signal?: string }>(
  'automations.exited',
)
/** Recurring script printed DONE and exited 0. */
export const Done = defineEvent<{ id: string; text?: string }>('automations.done')
/** Watcher could not recover its script, or a trigger exceeded its hourly fire cap. */
export const Escalated = defineEvent<{ id: string; reason: string }>('automations.escalated')
