import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { createDriver } from './driver.ts'
import type { runGoal } from './jev.ts'
import type { Driver, Observation } from './types.ts'
import { result, message, anchored, ObservationUnavailable } from './tool-helpers.ts'
import { isStopped } from './session.ts'
import { pixelDefaults, clock as realClock } from './perception.ts'
import type { PixelSettings, Clock } from './perception.ts'

export type Settings = {
  driverVersion?: string
  idleStopMinutes?: number
  jev?: Parameters<typeof runGoal>[1]['thresholds']
  pixel?: Partial<PixelSettings>
  imageMaxDimension?: number
  /** `false` turns off every task, scope, consent, confirmation and takeover gate; stop and secure-field masking stay. */
  guards?: boolean
}
/** Invalid types cannot relax safety; finite numeric settings are bounded at the configuration boundary. */
export function pixelSettings(value: unknown): PixelSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ObservationUnavailable('invalid_settings', 'computerUse.pixel must be an object.')
  const input = value as Record<string, unknown>
  const number = (key: string, min: number, max: number, fallback: number) => {
    const raw = input[key] === undefined ? fallback : input[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw))
      throw new ObservationUnavailable(
        'invalid_settings',
        `computerUse.pixel.${key} must be a finite number.`,
      )
    return Math.max(min, Math.min(max, raw))
  }
  for (const key of ['requireLabel', 'clipboard', 'fileTransfer'])
    if (key in input && typeof input[key] !== 'boolean')
      throw new ObservationUnavailable(
        'invalid_settings',
        `computerUse.pixel.${key} must be a boolean.`,
      )
  return {
    ...pixelDefaults,
    requireLabel: input.requireLabel === undefined ? true : (input.requireLabel as boolean),
    clipboard: input.clipboard === true,
    fileTransfer: input.fileTransfer === true,
    foregroundForDegraded: input.foregroundForDegraded === 'background' ? 'background' : 'takeover',
    labelRadius: number('labelRadius', 0, 48, pixelDefaults.labelRadius),
    minConfidence: number('minConfidence', 0.3, 1, pixelDefaults.minConfidence),
    settleMs: number('settleMs', 0, 10000, pixelDefaults.settleMs),
    maxWaitSeconds: number('maxWaitSeconds', 1, 600, pixelDefaults.maxWaitSeconds),
  }
}
/** Longest image side sent to the model: 512–2576, default 1568. */
export function imageMaxDimension(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(512, Math.min(2576, Math.round(value)))
    : 1568
}
/**
 * Read apart from `settings` so an invalid `pixel` block cannot fail captures that need no pixel settings, nor decide
 * the guards. Guards are off only for a literal `computerUse.guards: false` (project over user).
 */
export async function basicSettings(host: ExtensionHost) {
  const user = (await readSettings(userSettingsPath(host.userHome))).computerUse as
    | Settings
    | undefined
  const project = (await host.projectSettings()).computerUse as Settings | undefined
  return {
    imageMaxDimension: imageMaxDimension(project?.imageMaxDimension ?? user?.imageMaxDimension),
    guardsOff: (project?.guards ?? user?.guards) === false,
  }
}
export const imageSize = async (host: ExtensionHost) =>
  (await basicSettings(host)).imageMaxDimension
export const guardsOff = async (host: ExtensionHost) => (await basicSettings(host)).guardsOff
export async function settings(host: ExtensionHost): Promise<Settings> {
  const user = await readSettings(userSettingsPath(host.userHome))
  const project = await host.projectSettings()
  for (const raw of [
    (user.computerUse as Settings | undefined)?.pixel,
    (project.computerUse as Settings | undefined)?.pixel,
  ])
    if (raw !== undefined) pixelSettings(raw)
  const merged = {
    ...(user.computerUse as Settings | undefined),
    ...(project.computerUse as Settings | undefined),
  }
  return {
    ...merged,
    imageMaxDimension: imageMaxDimension(merged.imageMaxDimension),
    pixel: pixelSettings({
      ...(user.computerUse as Settings | undefined)?.pixel,
      ...(project.computerUse as Settings | undefined)?.pixel,
    }),
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
  clock?: Clock
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
      return result({
        status: error.status,
        message: error.message,
        ...(error.status === 'permission_required' ? { fix: PERMISSION_FIX } : {}),
      })
    throw error
  }
}
export const cacheKey = (conversation: number, app: string) =>
  `${conversation}:${app.toLowerCase()}`
/**
 * Take the runtime's single computer slot, waiting up to 5 s (runtime clock) for another call to release it. The slot
 * is claimed synchronously with the check, so two waiters never both get it. False when it stayed taken, or when the
 * call was aborted or stopped meanwhile; the caller releases with `busy = false`.
 */
export async function acquireBusy(host: ExtensionHost, conversation: number, signal: AbortSignal) {
  const state = runtime(host)
  const time = state.clock ?? realClock
  const deadline = time.now() + 5000
  while (state.busy && time.now() < deadline) {
    if (await isStopped(host, conversation, { signal })) return false
    await time.sleep(100, signal)
  }
  if (state.busy || signal.aborted) return false
  state.busy = true
  return true
}

/** Accessibility or Screen Recording permission missing, as the Driver words it when it gives no refusal code. */
export const permissionMissing = (text: string) =>
  /(accessibility|screen recording)\b[^.\n]*\b(permission|not (granted|enabled|allowed)|denied)|permission[^.\n]*\b(accessibility|screen recording)/i.test(
    text,
  )
export const PERMISSION_FIX = 'cua-driver permissions grant'
