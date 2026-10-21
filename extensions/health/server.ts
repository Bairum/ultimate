import { existsSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai'
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { ProviderHealth } from './refs.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { cloudConfig } from '../../lib/cloud.ts'
import { isMachineHome } from '../../lib/machine.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { readFileHealth, readHealth, record, reset, toHealth } from './store.ts'
import { HealthApi } from './api.ts'
import { LoginChanged } from '../models/api.ts'
import { PauseApi } from '../pause/api.ts'
import type { Flip, HealthEntry } from './store.ts'
import { implementAction } from '../../lib/actions.ts'
import { Changed, StateAction } from './refs.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** How often the machine home looks for providers due a ping. */
export const TICK = 10 * MINUTE
/** A failing provider is pinged again after this long, so a one-off error clears quickly. */
export const CONFIRM = 15 * MINUTE

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
    // Any failure since the last success, failing or not yet: a ping soon settles the streak either way.
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

/**
 * Emit `health.changed` for each flip that changed a provider's state, in a commit of its own: the state lives in the
 * machine's health file, not in storage. Nothing while storage is closed; a failure only logs, health is advisory.
 */
export async function announce(host: Pick<ExtensionHost, 'harness' | 'emit'>, flips: Flip[]) {
  const changed = flips.filter((flip) => flip.from !== flip.to)
  if (!changed.length) return
  let harness: ReturnType<ExtensionHost['harness']>
  try {
    harness = host.harness()
  } catch {
    // Storage is closed (a core swap): the next write that flips a state is announced.
    return
  }
  await harness
    .commit(async (tx) => {
      for (const { provider, to, error } of changed)
        await host.emit(tx, Changed, { provider, state: to, ...(error ? { error } : {}) })
    }, context)
    .catch((error: unknown) => console.error('health: announcing a change failed:', error))
}

/** Record `entry` in this machine's health file and hand the flip to `flipped`. */
export async function recordHealth(
  userHome: string,
  provider: string,
  entry: HealthEntry,
  flipped: (flips: Flip[]) => Promise<void> = async () => {},
) {
  await flipped([await record(userHome, provider, entry)])
}

/** Heartbeat dependencies on the host's model runtime and this machine's health file; `flipped` hears each write. */
export const hostDeps = (
  host: Pick<ExtensionHost, 'modelRuntime' | 'userHome'>,
  flipped: (flips: Flip[]) => Promise<void> = async () => {},
): HeartbeatDeps => ({
  now: Date.now,
  models: host.modelRuntime,
  read: async () => (await readFileHealth(host.userHome)).providers,
  record: (provider, entry) => recordHealth(host.userHome, provider, entry, flipped),
  forget: async (providers) => flipped(await reset(host.userHome, providers)),
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
  flipped: (flips: Flip[]) => Promise<void> = async () => {},
) {
  let known = loginProviders(path)
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    known = known.then(async (before) => {
      const after = await loginProviders(path)
      const providers = changedLogins(before, after)
      if (providers.length) await flipped(await reset(userHome, providers))
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
  state: implementAction(StateAction, async (_args, { host }) => {
    const providers = host.faux
      ? demoHealth(Date.now())
      : toHealth(await readFileHealth(host.userHome))
    return { machine: await machineName(host), providers }
  }),
}

export default function health(host: ExtensionHost) {
  // Resolved where it is called; declared here so the catalogue lists it.
  host.want(PauseApi)
  // A login added, replaced or removed through Ultimate makes the provider's record meaningless: start it over.
  // Each write that flips a provider's state is announced as `health.changed`.
  const flipped = (flips: Flip[]) => announce(host, flips)
  host.react('login-changed', [LoginChanged], async (tx, { data }) => {
    // In the reactor's transaction: its retry after a failure resets again but announces nothing twice.
    for (const { provider, from, to } of await reset(host.userHome, [data.provider]))
      if (from !== to) await host.emit(tx, Changed, { provider, state: to })
  })
  host.implement(HealthApi, {
    providers: () => readHealth(host.userHome),
    confirm: (provider) => confirm(hostDeps(host, flipped), provider),
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
            recordHealth(host.userHome, message.provider, entry, flipped).catch(
              (error: unknown) => {
                // Health is advisory: a failed write must never fail or delay the agent's generation.
                console.error('health: recording a response failed:', error)
              },
            )
          },
        }),
      ]
  if (host.faux || !isMachineHome(host.projectRoot, host.userHome))
    return defineExtension({ name: 'health', hooks })

  // Shared across reloads: a reload installs the new facet before the old one closes, and only one tick may run.
  // A resource keeps its first shape across reloads: add fields only as optional ones.
  const shared = host.resource('health.heartbeat', () => ({
    ticking: undefined as Promise<void> | undefined,
  }))
  const deps = hostDeps(host, flipped)
  const tick = () => {
    // Paused: no ping starts until Play; the next tick after it catches up.
    if (host.want(PauseApi)?.paused()) return
    shared.ticking ??= heartbeat(deps)
      .then(() => undefined)
      .catch((error: unknown) => host.notice(`Provider heartbeat: ${String(error)}`))
      .finally(() => {
        shared.ticking = undefined
      })
  }
  const start = setTimeout(tick, 30_000)
  const timer = setInterval(tick, TICK)
  // A login change resets that provider (here, or in the models action that made it): the tick pings it as due.
  const stopWatching = existsSync(dirname(authPath()))
    ? watchLogins(host.userHome, () => tick(), authPath(), 1000, flipped)
    : undefined
  host.onClose(async () => {
    clearTimeout(start)
    clearInterval(timer)
    stopWatching?.()
    await shared.ticking
  })
  return defineExtension({ name: 'health', hooks })
}
