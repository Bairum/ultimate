import { hostname } from 'node:os'
import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai'
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { MachineHealth, ProviderHealth } from '../../cloud/protocol.ts'
import type { ActionContext, ExtensionAction } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { cloudConfig } from '../cloud/config.ts'
import { isMachineHome } from '../subagents/primary.ts'
import { httpBase } from '../sync/server.ts'
import { readFileHealth, record, toHealth } from './store.ts'
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
}

/** Ping each due provider once, in sequence, with its cheapest model; returns the providers it pinged. */
export async function heartbeat(deps: HeartbeatDeps) {
  const available = await deps.models.getAvailable()
  const byProvider = new Map<string, Model<Api>[]>()
  for (const model of available)
    if (deps.models.getProviderAuthStatus(model.provider).configured)
      byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
  const pinged = due(await deps.read(), deps.now(), [...byProvider.keys()])
  for (const provider of pinged) {
    const model = cheapest(byProvider.get(provider)!)!
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
  }
  return pinged
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
  const hooks = host.faux
    ? []
    : [
        hook(GenerationTask, {
          afterResponse(message) {
            const entry = responseEntry(message, Date.now())
            if (!entry) return
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
  const shared = host.resource('health.heartbeat', () => ({
    ticking: undefined as Promise<void> | undefined,
    reported: 0,
  }))
  const deps: HeartbeatDeps = {
    now: Date.now,
    models: host.modelRuntime,
    read: async () => (await readFileHealth(host.userHome)).providers,
    record: (provider, entry) => record(host.userHome, provider, entry),
  }
  const tick = () => {
    shared.ticking ??= (async () => {
      const pinged = await heartbeat(deps)
      if (!pinged.length && Date.now() - shared.reported < REPORT) return
      await report(host).catch((error: unknown) => {
        // The cloud may be down or not deployed yet; the next tick reports again.
        console.error('health: report failed:', error instanceof Error ? error.message : error)
      })
      shared.reported = Date.now()
    })()
      .catch((error: unknown) => host.notice(`Provider heartbeat: ${String(error)}`))
      .finally(() => {
        shared.ticking = undefined
      })
  }
  const start = setTimeout(tick, 30_000)
  const timer = setInterval(tick, TICK)
  host.onClose(async () => {
    clearTimeout(start)
    clearInterval(timer)
    await shared.ticking
  })
  return defineExtension({ name: 'health', hooks })
}
