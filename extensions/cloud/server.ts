import { basename } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { EventToken } from '../../shared/events.ts'
import { implementAction } from '../../lib/actions.ts'
import { cloudConfig, fetchRegister } from '../../lib/cloud.ts'
import { projectIdentity } from '../../lib/project-identity.ts'
import { readSecret } from '../../lib/secrets.ts'
import { HealthApi } from '../health/api.ts'
import { PauseApi } from '../pause/api.ts'
import { SecretsApi } from '../secrets/api.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { backUp, classify, Conflict, readBackup } from './backup.ts'
import { join, joinState, saveCloud } from './join.ts'
import { BackupAction, BackupEvent, JoinAction, JoinStateAction, StateAction } from './refs.ts'
import type { CloudState } from './types.ts'

export const secrets = [
  { name: 'ULTIMATE_CLOUD_TOKEN', description: 'Bearer token for the cloud backup Worker' },
  {
    name: 'ULTIMATE_CLOUD_SNAPSHOT_KEY',
    description: 'Encrypts project backups; use the same value on every machine',
  },
]
const SNAPSHOT_KEY = 'ULTIMATE_CLOUD_SNAPSHOT_KEY'
/** A backup that takes longer is stopped. */
const BACKUP_CAP = 10 * 60_000
const PAUSED = 'Ultimate is paused; press Play first'

/**
 * This process's backup state, kept across reloads of the facet: the running upload, and the conflict and error
 * of the last attempt.
 */
interface Running {
  backup?: CloudState['backup']
  conflict?: CloudState['conflict']
  lastError?: string
}

/** Whether backups run here, and for which project; `cloud.state` reads it on every call. */
async function setup(host: ExtensionHost) {
  const config = await cloudConfig(host)
  if (!config) return { status: 'off' as const }
  const identity = await projectIdentity(host.projectRoot)
  if (!identity) return { status: 'local' as const, config }
  return { status: 'on' as const, config, key: identity.key }
}

/** Commit one event on its own, right after the change it records; a failure only reports. */
async function record<D extends JsonValue>(host: ExtensionHost, event: EventToken<D>, data: D) {
  await host
    .harness()
    .commit((tx) => host.emit(tx, event, data), context)
    .catch((error: unknown) => host.notice(`Cloud backup: ${String(error)}`))
}

/** The backup a forced one replaces, from the register; undefined when it cannot be read. */
async function latestIn(config: { url: string; token: string }, key: string) {
  // The conflict's own sentence already names the machine; the register only adds the confirm's details.
  const register = await fetchRegister(config).catch(() => undefined)
  const latest = register?.projects.find((project) => project.key === key)?.latest
  return latest && { id: latest.id, machine: latest.machine, at: latest.at }
}

const runningIn = (host: ExtensionHost) => host.resource('cloud.backup', (): Running => ({}))

/** Back up now: one at a time, never while paused. */
export async function backup(host: ExtensionHost, force: boolean) {
  const running = runningIn(host)
  if (running.backup) throw new Error('a backup is already running')
  if (host.want(PauseApi)?.paused()) throw new Error(PAUSED)
  // Set before the first await, so a second call refuses at once.
  running.backup = { done: 0, total: 0, uploaded: 0 }
  try {
    const ready = await setup(host)
    if (ready.status === 'off')
      throw new Error('Cloud backups are off: join the fleet with ⌘K → Join cloud fleet')
    if (ready.status === 'local')
      throw new Error(`${host.projectRoot} has no GitHub origin remote, so it cannot be backed up`)
    return await upload(host, running, ready, force)
  } finally {
    running.backup = undefined
  }
}

async function upload(
  host: ExtensionHost,
  running: Running,
  ready: { config: { url: string; token: string; machine: string }; key: string },
  force: boolean,
) {
  const started = Date.now()
  await record(host, BackupEvent, { phase: 'started', project: ready.key })
  try {
    const secret = process.env[SNAPSHOT_KEY] ?? (await readSecret(host.userHome, SNAPSHOT_KEY))
    if (!secret)
      throw new Error(`Missing ${SNAPSHOT_KEY}. Add it in the Secrets panel (⌘K → Secrets).`)
    const tailnet = host.want(TailscaleApi)?.status().url
    const health = await host.want(HealthApi)?.providers()
    const done = await backUp({
      ...ready.config,
      secret,
      key: ready.key,
      home: host.home,
      projectRoot: host.projectRoot,
      force,
      ...(tailnet?.startsWith('https://') ? { tailnet } : {}),
      ...(health?.length ? { health } : {}),
      signal: AbortSignal.timeout(BACKUP_CAP),
      progress: (read, total, uploaded) => {
        running.backup = { done: read, total, uploaded }
      },
    })
    running.conflict = running.lastError = undefined
    await record(host, BackupEvent, {
      phase: 'done',
      project: ready.key,
      bytes: done.bytes,
      uploaded: done.uploaded,
      ms: Date.now() - started,
    })
    return done
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof Conflict) {
      const latest = await latestIn(ready.config, ready.key)
      running.conflict = { error: message, ...(latest ? { latest } : {}) }
      running.lastError = undefined
    } else {
      running.conflict = undefined
      running.lastError = `Backup failed: ${message}`
      host.notice(running.lastError)
    }
    await record(host, BackupEvent, {
      phase: 'failed',
      project: ready.key,
      ms: Date.now() - started,
      reason: classify(error),
      ...(error instanceof Conflict ? { error: message } : {}),
    })
    throw error
  }
}

export const actions = {
  /** `{ status, name, machine, lastBackup, backup, conflict, lastError }` for the status line. */
  state: implementAction(StateAction, async (_args, { host }): Promise<CloudState> => {
    const ready = await setup(host)
    const running = runningIn(host)
    const name = basename(host.projectRoot)
    if (ready.status !== 'on') return { status: ready.status, name }
    const saved = await readBackup(host.home, ready.key)
    return {
      status: 'on',
      name,
      machine: ready.config.machine,
      ...(saved ? { lastBackup: saved.last } : {}),
      ...(running.backup ? { backup: { ...running.backup } } : {}),
      ...(running.conflict ? { conflict: running.conflict } : {}),
      ...(running.lastError ? { lastError: running.lastError } : {}),
    }
  }),
  /** User-only `{ force? }`: Back up now; resolves once the backup is committed. */
  backup: implementAction(BackupAction, (args, { host }) =>
    backup(host, (args as { force?: unknown } | null)?.force === true),
  ),
  /** Whether this machine joined the fleet: `cloud.url` and both secrets, without their values. */
  joinState: implementAction(JoinStateAction, (_args, { host }) => joinState(host.userHome)),
  /** User-only: the Join card's submit; checks the cloud, then stores the secrets and settings. */
  join: implementAction(JoinAction, async (args, { host }) => {
    const store = host.need(SecretsApi)
    return join(
      {
        fetch: (input, init) => fetch(input, init),
        setSecret: (name, value) => store.set(name, value),
        saveCloud: saveCloud(host.userHome),
      },
      args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    )
  }),
}
/** Backups and the Join card's secrets never come from an agent. */
export const userActions = ['backup', 'join']

export default function cloud(host: ExtensionHost) {
  // Optional services, resolved where they are called; declared here so the catalogue lists them.
  host.want(HealthApi)
  host.want(TailscaleApi)
  host.want(PauseApi)
  host.need(SecretsApi)
  return defineExtension({ name: 'cloud' })
}
