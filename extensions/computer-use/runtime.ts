import { Type } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { Profile } from '../subagents/api.ts'
import { normalizeArguments } from './policy.ts'
import { untrusted } from './content.ts'
import type { JsonValue } from '@earendil-works/chord'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { createDriver } from './driver.ts'
import { runGoal } from './jev.ts'
import type { Driver, Observation } from './types.ts'
import { readSession, updateSession } from './session.ts'
import * as task from './task.ts'

export type Settings = {
  driverVersion?: string
  idleStopMinutes?: number
  jev?: Parameters<typeof runGoal>[1]['thresholds']
}
export async function settings(host: ExtensionHost): Promise<Settings> {
  const user = await readSettings(userSettingsPath(host.userHome))
  const project = await host.projectSettings()
  return {
    ...(user.computerUse as Settings | undefined),
    ...(project.computerUse as Settings | undefined),
  }
}
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
export type Active = {
  stopped: boolean
  inFlight: boolean
  timer?: NodeJS.Timeout
  abort?: AbortController
  uncertain?: boolean
}
export type Runtime = {
  driver?: Promise<Driver>
  idle?: NodeJS.Timeout
  active: Map<number, Active>
  observations: Map<string, Observation>
  zoomed: Set<string>
  busy: boolean
  calls: Map<AbortController, number>
}
export function runtime(host: ExtensionHost) {
  return host.resource<Runtime>('computer-use.driver', () => {
    const state: Runtime = {
      active: new Map(),
      observations: new Map(),
      zoomed: new Set(),
      busy: false,
      calls: new Map(),
    }
    host.onClose(async () => {
      clearTimeout(state.idle)
      for (const active of state.active.values()) {
        active.stopped = true
        clearTimeout(active.timer)
      }
      if (state.driver) {
        const driver = await state.driver
        try {
          await driver.stop()
        } finally {
          await driver.close()
        }
      }
    })
    return state
  })
}
export async function driverFor(host: ExtensionHost) {
  const state = runtime(host)
  const config = await settings(host)
  state.driver ??= createDriver({ expectedVersion: config.driverVersion ?? '0.37.0' }).catch(
    (error) => {
      state.driver = undefined
      throw error
    },
  )
  clearTimeout(state.idle)
  const driver = await state.driver
  state.idle = setTimeout(
    () => {
      if (state.active.size) return
      state.observations.clear()
      state.zoomed.clear()
      driver.stop().catch((error) => console.error('computer-use: idle stop failed:', error))
    },
    (config.idleStopMinutes ?? 5) * 60_000,
  )
  state.idle.unref()
  return driver
}
export async function setup<T extends { output: { type: string }[] }>(
  host: ExtensionHost,
  conversation: number,
  work: (driver: Driver) => Promise<T>,
) {
  return anchored(host, conversation, await setupWork(host, work))
}
export async function setupWork<T>(host: ExtensionHost, work: (driver: Driver) => Promise<T>) {
  let driver: Driver
  try {
    driver = await driverFor(host)
  } catch (error) {
    const version = (await settings(host)).driverVersion ?? '0.37.0'
    return result({
      status: 'setup',
      message: message(error),
      install: `CUA_DRIVER_RS_VERSION=${version} bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`,
    })
  }
  try {
    return await work(driver)
  } catch (error) {
    if (error instanceof ObservationUnavailable)
      return result({ status: error.status, message: error.message })
    throw error
  }
}
export const cacheKey = (conversation: number, app: string) =>
  `${conversation}:${app.toLowerCase()}`
export const object = (value: JsonValue | undefined): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}

export class ObservationUnavailable extends Error {
  status: string
  constructor(status: string, reason: string) {
    super(reason)
    this.status = status
  }
}

export const windowSchema = Type.Optional(Type.Union([Type.String(), Type.Integer()]))

export const predicates = Type.Array(Type.Record(Type.String(), Type.Any()))

export function prepare(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return normalizeArguments(raw)
  const args = raw as Record<string, unknown>
  return {
    ...args,
    ...(Array.isArray(args.actions) ? { actions: args.actions.map(normalizeArguments) } : {}),
  }
}

export async function operatorOnly(host: ExtensionHost, api: ToolExecutionApi) {
  await api.agent(context)
  const profile = await host.harness().snapshot(Profile, api.conversationId, context)
  return profile?.definition === 'computer-operator'
    ? undefined
    : result({ status: 'operator_required', message: 'delegate to the computer-operator agent' })
}
