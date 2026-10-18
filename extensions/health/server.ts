import { existsSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai'
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { MachineHealth, ProviderHealth } from '../../cloud/protocol.ts'
import type { ActionContext, ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { cloudConfig, httpBase } from '../../lib/cloud.ts'
import { isMachineHome } from '../../lib/machine.ts'
import { readFileHealth, readHealth, record, reset, toHealth } from './store.ts'
import { HealthApi } from './api.ts'
import type { HealthEntry } from './store.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** How often the machine home looks for providers due a ping. */
export const TICK = 10 * MINUTE
/** A failing provider is pinged again after this long, so a one-off error clears quickly. */
export const CONFIRM = 15 * MINUTE
/** The cloud hears from the machine at least this often. */
export const REPORT = HOUR

/** The entry a terminal provider message records: `error` → a failure, `aborted` → nothing, else a success. */
export function responseEntry(message: AssistantMessage, now: number): HealthEntry | undefined {
  if (message.stopReason === 'aborted') return undefined
  if (message.stopReason === 'error')
    return { lastFail: now, error: message.errorMessage ?? 'error', lastUsed: now }
  return { lastOk: now, lastUsed: now }
}

/** The ping interval from machine activity: the last real call on any provider. */
export function interval(entries: Record<string, HealthEntry>, now: number) {
  const used = Math.max(...Object.values(entries).map((entry) => entry.lastUsed ?? -Infinity))
  const idle = now - used
  return idle < 4 * HOUR ? HOUR : idle < 12 * HOUR ? 4 * HOUR : 8 * HOUR
}

/** The `providers` due a heartbeat ping at `now`. */
export function due(entries: Record<string, HealthEntry>, now: number, providers: string[]) {
  const every = interval(entries, now)
  return providers.filter((provider) => {
    const entry = entries[provider] ?? {}
    const failing = entry.lastFail !== undefined && entry.lastFail > (entry.lastOk ?? 0)
    if (failing && now - (entry.lastChecked ?? 0) >= CONFIRM) return true
    return now - Math.max(entry.lastOk ?? 0, entry.lastChecked ?? 0) >= every
  })
}

/** The model with the lowest `cost.input + cost.output`; the first on a tie. */
export function cheapest<T extends Pick<Model<Api>, 'cost'>>(models: readonly T[]) {
  let best: T | undefined
  for (const model of models)
    if (!best || model.cost.input + model.cost.output < best.cost.input + best.cost.output)
      best = model
  return best
}

export interface HeartbeatDeps {
  now(): number
  models: Pick<Models, 'completeSimple'> & {
    getAvailable(): Promise<readonly Model<Api>[]>
    getProviderAuthStatus(provider: string): { configured: boolean }
  }
  read(): Promise<Record<string, HealthEntry>>
  record(provider: string, entry: HealthEntry): Promise<unknown>
  forget(providers: string[]): Promise<unknown>
}

/** The configured providers' available models, by provider. */
async function configured(models: HeartbeatDeps['models']) {
  const byProvider = new Map<string, Model<Api>[]>()
  for (const model of await models.getAvailable())
    if (models.getProviderAuthStatus(model.provider).configured)
      byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
  return byProvider
}

/** One tiny request with `provider`'s cheapest model, recorded as a check; returns whether it answered. */
async function ping(deps: HeartbeatDeps, provider: string, models: readonly Model<Api>[]) {
  const model = cheapest(models)!
  let error: string | undefined
  try {
    const answer = await deps.models.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'ping', timestamp: deps.now() }] },
      { maxTokens: 16, signal: AbortSignal.timeout(60_000) },
    )
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
      error = answer.errorMessage ?? answer.stopReason
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const now = deps.now()
  await deps.record(
    provider,
    error === undefined
      ? { lastChecked: now, lastOk: now }
      : { lastChecked: now, lastFail: now, error },
  )
  return error === undefined
}

/**
 * Forget the entries of providers without a login here (one removed, or a provider nothing logs in to any more), then
 * ping each due provider once, in sequence, with its cheapest model. Returns the providers it forgot and pinged.
 */
export async function heartbeat(deps: HeartbeatDeps) {
  const byProvider = await configured(deps.models)
  const entries = await deps.read()
  const pruned = Object.keys(entries).filter((provider) => !byProvider.has(provider))
  if (pruned.length) await deps.forget(pruned)
  const pinged = due(entries, deps.now(), [...byProvider.keys()])
  for (const provider of pinged) await ping(deps, provider, byProvider.get(provider)!)
  return { pruned, pinged }
}

/**
 * Ping `provider` now, as a move's checks do before a recorded failure blocks it, so a stale or one-off failure never
 * blocks a move by itself. False when it is not configured or the ping fails.
 */
export async function confirm(deps: HeartbeatDeps, provider: string) {
  const models = (await configured(deps.models)).get(provider)
  return models ? ping(deps, provider, models) : false
}

/** Heartbeat dependencies on the host's model runtime and this machine's health file. */
export const hostDeps = (
  host: Pick<ExtensionHost, 'modelRuntime' | 'userHome'>,
): HeartbeatDeps => ({
  now: Date.now,
  models: host.modelRuntime,
  read: async () => (await readFileHealth(host.userHome)).providers,
  record: (provider, entry) => record(host.userHome, provider, entry),
  forget: (providers) => reset(host.userHome, providers),
})

/** Pi's credential store, shared with `pi`: one entry per logged-in provider. */
export const authPath = () => join(getAgentDir(), 'auth.json')

/** The providers with a stored login, read as keys only; a missing or unreadable file has none. */
export async function loginProviders(path = authPath()) {
  try {
    return new Set(Object.keys(JSON.parse(await readFile(path, 'utf8')) as object))
  } catch {
    // No file yet, or one Pi is rewriting: no logins, and the next change event reads it again.
    return new Set<string>()
  }
}

/** The providers in only one of the two sets: a login added or removed. */
export const changedLogins = (before: Set<string>, after: Set<string>) => [
  ...[...after].filter((provider) => !before.has(provider)),
  ...[...before].filter((provider) => !after.has(provider)),
]

/**
 * Watch Pi's `auth.json` (logins from `pi` or any Ultimate home on this machine): reset the health of each provider
 * whose login appeared or disappeared, then call `changed` with whether any did. A token refresh, or a login replaced
 * in `pi`, rewrites the file without changing its providers; a failing provider is then pinged again within
 * `CONFIRM`. Ultimate's own login and logout reset the provider themselves (`extensions/models`). Returns the stop
 * function.
 */
export function watchLogins(
  userHome: string,
  changed: (providers: boolean) => void,
  path = authPath(),
  delay = 1000,
) {
  let known = loginProviders(path)
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    known = known.then(async (before) => {
      const after = await loginProviders(path)
      const providers = changedLogins(before, after)
      if (providers.length) await reset(userHome, providers)
      changed(providers.length > 0)
      return after
    })
    known.catch((error: unknown) => {
      // Health is advisory: a failed reset leaves the old state until the next call or ping corrects it.
      console.error('health: login change not applied:', error)
    })
  }
  // The directory, not the file: Pi replaces the file, which would end a watch on its old inode.
  const watcher = watch(dirname(path), (_event, name) => {
    if (name !== null && name !== basename(path)) return
    clearTimeout(timer)
    timer = setTimeout(settle, delay)
  })
  watcher.on('error', (error) => console.error('health: auth.json watch failed:', error))
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}

/** What a faux host shows: one provider ok, one failing, one never seen. */
export function demoHealth(now: number): ProviderHealth[] {
  return [
    {
      provider: 'anthropic',
      state: 'failing',
      lastOk: now - 26 * HOUR,
      lastFail: now - 3 * HOUR,
      error: 'invalid_grant',
      lastUsed: now - 3 * HOUR,
    },
    { provider: 'claude-code', state: 'unknown' },
    {
      provider: 'openai-codex',
      state: 'ok',
      lastOk: now - 12 * MINUTE,
      lastUsed: now - 12 * MINUTE,
    },
  ]
}

async function machineName(host: Pick<ExtensionHost, 'userHome' | 'faux' | 'notice'>) {
  return (await cloudConfig(host))?.machine ?? hostname()
}

export const actions = {
  /** `{ machine, providers }`: this machine's provider health; a faux host answers a fixed demo. */
  async state(_args: JsonValue, { host }: ActionContext) {
    const providers = host.faux
      ? demoHealth(Date.now())
      : toHealth(await readFileHealth(host.userHome))
    return { machine: await machineName(host), providers } as unknown as JsonValue
  },
} satisfies Record<string, ExtensionAction>

/** When the cloud last accepted a report, and whether a newer one is still owed (a failed attempt). */
export type Reports = { reported: number; pending?: boolean }

/** Report after a tick that pinged, while an earlier report is still owed, or once `REPORT` has passed. */
export const shouldReport = (reports: Reports, pinged: boolean, now: number) =>
  pinged || !!reports.pending || now - reports.reported >= REPORT

/** `POST /sync/health` with this machine's health; skipped while cloud sync is not configured. */
async function report(host: ExtensionHost) {
  const cloud = await cloudConfig(host)
  if (!cloud) return
  const body: MachineHealth = {
    machine: cloud.machine,
    at: Date.now(),
    providers: toHealth(await readFileHealth(host.userHome)),
  }
  const response = await fetch(new URL('/sync/health', httpBase(cloud.url)), {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`POST /sync/health: ${response.status}`)
}

export default function health(host: ExtensionHost) {
  host.implement(HealthApi, {
    forget: (provider) => reset(host.userHome, [provider]),
    providers: () => readHealth(host.userHome),
    confirm: (provider) => confirm(hostDeps(host), provider),
  })
  const hooks = host.faux
    ? []
    : [
        hook(GenerationTask, {
          afterResponse(message) {
            const entry = responseEntry(message, Date.now())
            // Only providers with a login here: a stray model reference to another fails, which is not its health.
            if (!entry || !host.modelRuntime.getProviderAuthStatus(message.provider).configured)
              return
            record(host.userHome, message.provider, entry).catch((error: unknown) => {
              // Health is advisory: a failed write must never fail or delay the agent's generation.
              console.error('health: recording a response failed:', error)
            })
          },
        }),
      ]
  if (host.faux || !isMachineHome(host.projectRoot, host.userHome))
    return defineExtension({ name: 'health', hooks })

  // Shared across reloads: a reload installs the new facet before the old one closes, and only one tick may run.
  // A resource keeps its first shape across reloads: add fields only as optional ones.
  const shared = host.resource('health.heartbeat', () => ({
    ticking: undefined as Promise<void> | undefined,
    reported: 0,
    pending: false as boolean | undefined,
  }))
  const deps = hostDeps(host)
  const tick = () => {
    shared.ticking ??= (async () => {
      const { pruned, pinged } = await heartbeat(deps)
      if (!shouldReport(shared, pruned.length + pinged.length > 0, Date.now())) return
      shared.pending = true
      await report(host).then(
        () => {
          shared.reported = Date.now()
          shared.pending = false
        },
        (error: unknown) => {
          // The cloud may be down or not deployed yet; `pending` stays set, so the next tick reports again.
          console.error('health: report failed:', error instanceof Error ? error.message : error)
        },
      )
    })()
      .catch((error: unknown) => host.notice(`Provider heartbeat: ${String(error)}`))
      .finally(() => {
        shared.ticking = undefined
      })
  }
  const start = setTimeout(tick, 30_000)
  const timer = setInterval(tick, TICK)
  // A login change resets that provider (here, or in the models action that made it): the tick pings it as due and
  // reports; a removed one has nothing to ping, so its report is owed explicitly.
  const stopWatching = existsSync(dirname(authPath()))
    ? watchLogins(host.userHome, (providers) => {
        if (providers) shared.pending = true
        tick()
      })
    : undefined
  host.onClose(async () => {
    clearTimeout(start)
    clearInterval(timer)
    stopWatching?.()
    await shared.ticking
  })
  return defineExtension({ name: 'health', hooks })
}
