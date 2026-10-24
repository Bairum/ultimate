import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { TaskId, ConversationId } from '@earendil-works/pi-durable'

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
