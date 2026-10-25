import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { Profile } from '../subagents/api.ts'
import { untrusted } from './content.ts'
import type { JsonValue } from '@earendil-works/chord'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSession, updateSession } from './session.ts'
import * as task from './task.ts'
export const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
export const result = (value: unknown) => ({
  output: [{ type: 'text' as const, text: untrusted(value) }],
  structuredOutput: json(value),
})
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
// Keep the original result (including its first block) intact; grounding always comes last.
export async function anchored<T extends { output: { type: string }[] }>(
  host: ExtensionHost,
  conversation: number,
  value: T,
) {
  const state = (await readSession(host, conversation)).task
  return {
    ...value,
    output: [
      ...value.output,
      {
        type: 'text' as const,
        text: state
          ? task.anchor(state)
          : "No active task: call computer_task start with the user's words before acting.",
      },
    ],
  }
}
// Durable document overlays are proxies, not structured-cloneable plain objects.
export const plainTask = (state: task.TaskState) =>
  JSON.parse(JSON.stringify(state)) as task.TaskState
export async function changeTask(
  host: ExtensionHost,
  conversation: number,
  change: (state: task.TaskState) => task.TaskState,
) {
  await updateSession(host, conversation, (doc) => {
    if (doc.task) doc.task = change(plainTask(doc.task))
  })
}
export function activatePending(state: task.TaskState) {
  const firstPending = state.subgoals.find((s) => s.status === 'pending')
  return !state.subgoals.some((s) => s.status === 'active') && firstPending
    ? task.activate(state, firstPending.id, Date.now())
    : state
}
export const object = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}

export class ObservationUnavailable extends Error {
  status: string
  constructor(status: string, reason: string) {
    super(reason)
    this.status = status
  }
}
export async function operatorOnly(host: ExtensionHost, api: ToolExecutionApi) {
  const agent = await api.agent(context)
  const profile = await host.harness().snapshot(Profile, api.conversationId, context)
  return profile?.definition === 'computer-operator' &&
    agent.tools.every((tool) => tool.name.startsWith('computer_') || tool.name === 'read')
    ? undefined
    : result({ status: 'operator_required', message: 'delegate to the computer-operator agent' })
}
