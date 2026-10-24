import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { TaskId, ConversationId } from '@earendil-works/pi-durable'

export type TriggerEvent = { name: string; description: string; fields: Record<string, string> }
/** The labels automations gives the conversations it creates: a prompt run's, and a script's watcher. */
export const RunLabel = 'automation'
export const WatcherLabel = 'watcher'

export type Schedule =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'at'; time: string }
  | { kind: 'every'; ms: number }
export type Run = {
  id: string
  firedAt: number
  conversationId?: ConversationId
  status: 'running' | 'done' | 'failed' | 'aborted' | 'skipped'
  finishedAt?: number
  answer?: string
}
export type Automation = {
  id: string
  scope?: 'project'
  name: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  schedule?: Schedule
  event?: { name: string; where?: Record<string, string | number | boolean>; sinceEvent: number }
  condition?: {
    metric: 'context'
    of: string
    above: number
    cooldownMs: number
    armed: boolean
    value?: number
  }
  recentFires?: number[]
  /** What the user allowed this automation's woken agent to do for them on a fire; only the user sets it. */
  grant?: Grant
  /**
   * The fire each granted action last acted on, and what it did: one act per action and fire. Kept apart from `grant`,
   * so editing the grant never allows a second act on the same fire.
   */
  acted?: Partial<Record<GrantAction, Acted>>
  /**
   * What each of the last 20 `act` tool calls did, by tool task, written with its effect: a replay of that call returns
   * it, whatever fired since, and never acts again.
   */
  receipts?: Record<string, Acted['result']>
  script?: {
    ask: string
    once: boolean
    secrets?: string[]
    conversationId: number
    state: 'writing' | 'running' | 'investigating' | 'failed' | 'stopped' | 'done'
    pid?: number
    startedAt?: number
    exitedAt?: number
    exitCode?: number
    lastOutputAt?: number
    error?: string
  }
  prompt?: string
  agent?: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  subscribers: number[]
  nextAt?: number
  scheduler?: TaskId
  runs: Run[]
  fires: number
  lastFireAt?: number
}
export type AutomationListItem = Automation & { alive: boolean }
export type CreateArgs = {
  name: string
  schedule?: string | Schedule
  ask?: string
  event?: { name: string; where?: Record<string, string | number | boolean> }
  condition?: { metric: 'context'; of: string; above: number; cooldownMs?: number }
  once?: boolean
  secrets?: string[]
  prompt?: string
  agent?: string
  model?: { provider: string; modelId: string }
  thinking?: ModelThinkingLevel
  subscribers?: number[]
  scope?: 'user' | 'project'
  slug?: string
}
export type Args = Partial<CreateArgs> & {
  action: string
  id?: string
  runId?: string
  to?: string
  lines?: number
  reason?: string
}
export type Manifest = { name: string; ask: string; once: boolean; secrets?: string[] }
export type Effect = { id: string; action: string; previousPid?: number }
export const isSlug = (id: string) => /^[a-z][a-z0-9-]{0,62}$/.test(id) && !(id in Object.prototype)
export const isId = (id: string) => /^A[1-9]\d*$/.test(id) || isSlug(id)

/** Only stdout has a protocol; stderr never fires an automation. */
export function fireText(line: string, stdout: boolean): string | undefined {
  return stdout && /^FIRE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}
/** DONE takes effect only when the script exits 0. */
export function doneText(line: string, stdout: boolean): string | undefined {
  return stdout && /^DONE(?:\s|$)/.test(line) ? line.slice(4).trim() : undefined
}
/** Keep both bounds even for a single very long output line. */
export function trimLog(text: string): string {
  const lines = text.split('\n').slice(-2001).join('\n')
  const bytes = Buffer.from(lines)
  return bytes.length > 256 * 1024 ? bytes.subarray(-256 * 1024).toString('utf8') : lines
}

/** Who acted for the user: automation `automation`, named `name`, under the user's grant, at `at`. */
export type GrantedBy = { automation: string; name: string; at: number }
/**
 * What a granted fire may do without asking: `dream` starts a dream session, `compact` compacts a context, `asleep`
 * falls asleep into a new chapter. Each is named on its own; `asleep` never follows from `dream`.
 */
export const GRANT_ACTIONS = ['dream', 'compact', 'asleep'] as const
export type GrantAction = (typeof GRANT_ACTIONS)[number]
/** The user's grant: the `actions` allowed, in `source` the user's words or where they set it, `at` when. */
export type Grant = { actions: GrantAction[]; source: string; at: number }
/**
 * One granted act: on fire `fire`, at `at`, by conversation `by`, in tool task `task` when a tool call asked, with the
 * `result` it committed together with its effect (a replay of that call returns it).
 */
export type Acted = {
  fire: number
  at: number
  by: number
  task?: number
  result: { [key: string]: string | number }
}

/** The task kind of an automation's prompt run, which owns the run's conversation. */
export const RUN_TASK = 'ultimate.automation-run'
