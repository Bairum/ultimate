/**
 * Automations in the browser: the scheduled agent prompts and their runs, and the actions the Automations panel
 * manages them with. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** When an automation fires: a cron expression in a timezone, once at an ISO time, or every `ms` milliseconds. */
export type Schedule =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'at'; time: string }
  | { kind: 'every'; ms: number }
/** One firing of an automation; `conversationId` is the conversation it ran in. */
export type Run = {
  id: string
  firedAt: number
  conversationId?: number
  status: 'running' | 'done' | 'failed' | 'aborted' | 'skipped'
  finishedAt?: number
  answer?: string
}
/** A scheduled prompt; `agent` names the definition it runs as, else it copies the root agent. */
export type Automation = {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextAt?: number
  runs: Run[]
  agent?: string
}
/** A schedule parsed, in words, and its next fire times. */
export type Described = { schedule: Schedule; description: string; next: number[] }
/**
 * A schedule as text: `cron "0 9 * * 1-5" Europe/Vienna` (timezone optional), `at 2026-12-01T09:00:00Z`, `in 30m`,
 * `every 15m`, or parsed.
 */
type ScheduleInput = string | Schedule
/** An automation's id, `A<n>`. */
type Id = { id: string }

/** No arguments → every automation. */
export const ListAction = actionRef<null, Automation[]>('automations', 'list')
/** `{ schedule }` → the schedule parsed, in words, and its next three fire times (one for `at`). */
export const DescribeAction = actionRef<{ schedule: ScheduleInput }, Described>(
  'automations',
  'describe',
)
/** `{ name, prompt, schedule, agent? }` → the new automation, enabled. */
export const CreateAction = actionRef<
  { name: string; prompt: string; schedule: ScheduleInput; agent?: string },
  Automation
>('automations', 'create')
/** `{ id, name?, prompt?, schedule?, agent? }` → the automation updated; an empty `agent` copies the root agent again. */
export const UpdateAction = actionRef<
  Id & { name?: string; prompt?: string; schedule?: ScheduleInput; agent?: string },
  Automation
>('automations', 'update')
/** `{ id }` → the automation, paused. */
export const PauseAction = actionRef<Id, Automation>('automations', 'pause')
/** `{ id }` → the automation, enabled again; fails for a one-shot whose time has passed. */
export const ResumeAction = actionRef<Id, Automation>('automations', 'resume')
/** `{ id }` → the run fired now. */
export const RunAction = actionRef<Id, Run>('automations', 'run')
/** `{ id }` → `{ id }`: delete the automation; its conversations stay. */
export const DeleteAction = actionRef<Id, Id>('automations', 'delete')
