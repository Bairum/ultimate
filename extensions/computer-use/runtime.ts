import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { createDriver } from './driver.ts'
import type { runGoal } from './jev.ts'
import type { Driver, Observation } from './types.ts'
import { result, message, anchored, ObservationUnavailable } from './tool-helpers.ts'
import { isStopped } from './session.ts'

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
  if (await isStopped(host, conversation))
    return anchored(host, conversation, result({ status: 'stopped' }))
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
