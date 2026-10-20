import { existsSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { HELLO_LIMITS, PROJECT_KEY, PROJECT_MISMATCH, validTailnet } from '../../cloud/protocol.ts'
import type { CloudMessage, MachineMessage, Transition, Writer } from '../../cloud/protocol.ts'
import { secretMetadata } from '../../lib/secrets.ts'
import { HealthApi } from '../health/api.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { PauseApi } from '../pause/api.ts'
import { cloudConfig, leaseSettings } from '../../lib/cloud.ts'
import { projectIdentity } from '../../lib/project-identity.ts'
import { Feedback } from './api.ts'
import { startLease } from './lease.ts'
import type { Lease, LeaseDeps } from './lease.ts'
import type { CloudState } from './types.ts'
import * as snapshot from './snapshot.ts'
import { implementAction } from '../../lib/actions.ts'
import { BackupAction, CancelAction, MoveHereAction, StateAction } from './refs.ts'

export const secrets = [
  { name: 'ULTIMATE_CLOUD_TOKEN', description: 'Bearer token for the cloud sync endpoint' },
  {
    name: 'ULTIMATE_CLOUD_SNAPSHOT_KEY',
    description:
      'Encrypts project snapshots moved between machines; use the same value on every machine',
  },
]

export type SyncSocket = Pick<WebSocket, 'send' | 'close' | 'addEventListener'>
export type Connect = (url: string, token: string) => SyncSocket
// Node 26 accepts undici's options overload; DOM declarations only describe browser WebSockets.
const NodeWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => SyncSocket
const connect: Connect = (url, token) =>
  new NodeWebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
/** How often the user's secret names are compared with the ones the cloud last heard. */
export const SECRETS_CHECK = 5000
/** A connection open this long that drops (a deploy restarting the replica) reconnects at once, without backoff. */
export const QUICK_RECONNECT_AFTER = 10_000
/**
 * How often an open socket sends the text frame `ping`; the replica answers `pong` without waking. A socket that heard
 * no `pong` for two of them is half-open (a sleeping laptop, a changed network) and reconnects.
 */
export const PING_EVERY = 30_000

/** This machine's place in the project: the last role the cloud gave it, kept across reconnects. */
export interface SyncState {
  key: string
  connected: boolean
  role?: 'writer' | 'standby'
  epoch?: number
  /** The lease is free: a standby may claim it at `epoch`. */
  free?: boolean
  snapshot?: { id: string; epoch: number }
  writer?: Writer
  /** The latest move the cloud reported, running or ended. */
  transition?: Transition
  /** The replica's project key, under which its snapshots live. */
  project?: { key: string }
}

export interface SyncOptions {
  url: string
  token: string
  machine: string
  identity: { key: string; rootCommit: string }
}

/** How a connection serves the lease lifecycle (`lease.ts`). */
export interface SyncHooks {
  /** The harness is open: as the writer this connection records the lease epoch it is given. */
  serving: boolean
  /** Each role, once the state holds it, from inside the message chain: defer any lifecycle switch. */
  role?(state: SyncState): void
  /** The writer hears that the standby `by` asked for the lease, for transition `id`; `force` skips its holds. */
  releaseRequested?(by: string, id: string, force: boolean): void
  /**
   * The requester hears what the writer's release waits for: `tasks` running tasks of the conversations `runs`, then
   * its worktrees with uncommitted changes (`dirty` with `held`), or the ones that stay behind (`dirty` alone).
   */
  releaseWaiting?(waiting: Omit<Extract<CloudMessage, { type: 'release-waiting' }>, 'type'>): void
  /** The cloud UI or @sync (`by`) asks this standby to take the lease as transition `id`. */
  moveTo?(id: string, force: boolean, by: 'cloud' | 'sync'): void
  /** The cloud UI stops transition `id`. */
  cancel?(id: string): void
  /** The transition this machine prepares, named in hello so the cloud keeps it. */
  transition?(): string | undefined
  /** When this machine last finished a backup of the project, named in hello for the fleet. */
  lastBackupAt?(): number | undefined
  /** A connection after the first said hello: its first role answers what an earlier one left unanswered. */
  hello?(): void
}

/** One outbound connection for the lease; injected transport keeps sync tests entirely in process. */
export function startSync(
  host: ExtensionHost,
  { url, token, machine, identity }: SyncOptions,
  dial = connect,
  hooks: SyncHooks = { serving: true },
) {
  const { serving } = hooks
  let socketSend: ((message: MachineMessage) => boolean) | undefined
  let stopped = false
  let retry = 1000
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let dispose: (() => void) | undefined
  let idle: (() => Promise<void>) | undefined
  let state: SyncState = { key: identity.key, connected: false }
  const leasePath = join(host.home, 'cloud-lease.json')
  const readLease = async () => {
    try {
      const lease = JSON.parse(await readFile(leasePath, 'utf8')) as {
        key?: unknown
        epoch?: unknown
      }
      return lease.key === identity.key && Number.isSafeInteger(lease.epoch)
        ? (lease.epoch as number)
        : undefined
    } catch {
      // No lease yet, or an unreadable one: hello names no epoch, and the writer's role rewrites it.
      return undefined
    }
  }
  /** A claim in flight (`lease.ts`) names the epoch it wins, so the replica knows this machine as that writer. */
  const claimEpoch = async () => {
    try {
      const intent = JSON.parse(await readFile(join(host.home, 'cloud-claim.json'), 'utf8')) as {
        key?: unknown
        epoch?: unknown
      }
      return intent.key === identity.key && Number.isSafeInteger(intent.epoch)
        ? (intent.epoch as number) + 1
        : undefined
    } catch {
      // No claim in flight.
      return undefined
    }
  }
  const writeLease = async (epoch: number) => {
    if ((await readLease()) === epoch) return
    await writeFile(`${leasePath}.tmp`, JSON.stringify({ key: identity.key, epoch }))
    await rename(`${leasePath}.tmp`, leasePath)
  }
  // On standby, `<home>/cloud-writer.json` names the machine running the project and its tailnet address, so the
  // `ultimate` command opens that machine directly. It goes away when this checkout writes or the writer has none.
  const writerPath = join(host.home, 'cloud-writer.json')
  let lastWriter: string | undefined
  const recordWriter = async (writer: Writer | undefined) => {
    const value =
      writer?.machine && writer.machine !== machine && writer.tailnet
        ? JSON.stringify({ machine: writer.machine, tailnet: writer.tailnet })
        : ''
    if (value === lastWriter) return
    lastWriter = value
    if (!value) return rm(writerPath, { force: true })
    await writeFile(`${writerPath}.tmp`, value)
    await rename(`${writerPath}.tmp`, writerPath)
  }
  /** Where this checkout answers on the tailnet, once the `tailscale` extension published it. */
  const tailnet = () => {
    const published = host.want(TailscaleApi)?.status().url
    return validTailnet(published) ? published : undefined
  }
  /** Secret names the cloud accepts, and whether that is every one in the store. */
  const secretNames = async () => {
    try {
      const all = (await secretMetadata(host.userHome)).map((secret) => secret.name)
      const names = all
        .filter((name) => HELLO_LIMITS.secret.test(name))
        .slice(0, HELLO_LIMITS.secrets)
      return { secrets: names, secretsComplete: names.length === all.length }
    } catch {
      // The Secrets panel reports an unreadable store; until it is repaired this machine cannot vouch for any.
      return { secrets: [], secretsComplete: false }
    }
  }
  const hasHistory = async () =>
    // A standby's storage is closed; any database it kept is its own history.
    !serving
      ? existsSync(join(host.home, 'state.sqlite'))
      : host
          .harness()
          .commit(
            async (tx) =>
              (await tx.scanConversations({}, 2)).items.length > 1 ||
              (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)).items.length > 0,
            context,
          )
  const open = () => {
    if (stopped) return
    let socket: SyncSocket
    try {
      const endpoint = new URL(url)
      endpoint.pathname = '/sync/v2'
      endpoint.search = ''
      endpoint.searchParams.set('project', identity.key)
      socket = dial(endpoint.href, token)
    } catch (error) {
      host.notice(`Cloud connection failed: ${String(error)}`)
      schedule()
      return
    }
    let closed = false
    let secretsTimer: ReturnType<typeof setInterval> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined
    /** Pings sent since the last `pong`. */
    let unanswered = 0
    let openedAt: number | undefined
    let role: SyncState['role']
    let chain = Promise.resolve()
    idle = () => chain
    const send = (message: MachineMessage) => {
      if (!closed) socket.send(JSON.stringify(message))
    }
    socketSend = (message) => {
      if (closed || !role) return false
      send(message)
      return true
    }
    const enqueue = (work: () => Promise<void>) => {
      chain = chain
        .then(async () => {
          if (!closed) await work()
        })
        .catch((error: unknown) => {
          host.notice(`Cloud sync failed: ${String(error)}`)
          close()
        })
    }
    const close = () => {
      if (closed) return
      closed = true
      state = { ...state, connected: false }
      clearInterval(secretsTimer)
      clearInterval(pingTimer)
      socket.close()
      // A connection that had been up a while dropped, as a deploy restarting the replica does: try again at once.
      // Backoff applies from the next failure on, so a socket that never opens, or keeps closing soon, waits.
      if (!stopped)
        schedule(
          openedAt !== undefined && Date.now() - openedAt >= QUICK_RECONNECT_AFTER ? 0 : undefined,
        )
    }
    dispose = close
    // The user's secret names and the tailnet address travel in hello, then whenever they change, so missing secrets
    // stay current and the address shows once Tailscale published it.
    let lastSecrets: string | undefined
    let lastTailnet: string | null | undefined
    socket.addEventListener('open', () => {
      openedAt = Date.now()
      pingTimer = setInterval(() => {
        if (closed) return
        if (unanswered >= 2) {
          host.notice('Cloud sync: no answer for 60 s; reconnecting')
          return close()
        }
        unanswered++
        socket.send('ping')
      }, PING_EVERY)
      secretsTimer = setInterval(
        () =>
          enqueue(async () => {
            if (!role || lastSecrets === undefined) return
            const address = tailnet() ?? null
            if (address !== lastTailnet) {
              lastTailnet = address
              send({ type: 'tailnet', url: address })
            }
            const current = await secretNames()
            if (JSON.stringify(current) === lastSecrets) return
            lastSecrets = JSON.stringify(current)
            send({ type: 'secrets', ...current })
          }),
        SECRETS_CHECK,
      )
      enqueue(async () => {
        hooks.hello?.()
        const names = await secretNames()
        lastSecrets = JSON.stringify(names)
        const address = tailnet()
        lastTailnet = address ?? null
        send({
          type: 'hello',
          key: identity.key,
          rootCommit: identity.rootCommit,
          root: host.projectRoot,
          machine,
          build: host.build().id,
          port: Number(new URL(host.system().process.url).port),
          epoch: (await claimEpoch()) ?? (await readLease()),
          history: await hasHistory(),
          ...names,
          ...(hooks.transition?.() ? { transition: hooks.transition() } : {}),
          ...(address ? { tailnet: address } : {}),
          ...(hooks.lastBackupAt?.() ? { lastBackupAt: hooks.lastBackupAt() } : {}),
        })
      })
    })
    socket.addEventListener('message', (event) => {
      if (event.data === 'pong') {
        unanswered = 0
        return
      }
      try {
        const message = JSON.parse(String(event.data)) as CloudMessage
        if (message.type === 'role')
          enqueue(async () => {
            const { type: _, ...given } = message
            // On standby the lease module records the epoch once it opens storage as the writer.
            if (message.role === 'writer' && serving) await writeLease(message.epoch)
            // Finish file I/O before notifying the lease: its deferred callback may send on this role.
            await recordWriter(message.role === 'standby' ? message.writer : undefined)
            state = { key: identity.key, connected: true, ...given }
            role = message.role
            retry = 1000
            hooks.role?.(state)
          })
        else if (message.type === 'release-requested')
          hooks.releaseRequested?.(message.by, message.id, message.force === true)
        else if (message.type === 'release-waiting') hooks.releaseWaiting?.(message)
        else if (message.type === 'move-to')
          hooks.moveTo?.(
            message.id,
            message.force === true,
            message.by === 'sync' ? 'sync' : 'cloud',
          )
        else if (message.type === 'cancel') hooks.cancel?.(message.id)
      } catch (error) {
        host.notice(`Cloud sync failed: ${String(error)}`)
        close()
      }
    })
    socket.addEventListener('close', (event) => {
      if (closed) return
      if (event.code === PROJECT_MISMATCH) {
        stopped = true
        host.notice(
          `Cloud sync stopped: the cloud refused ${identity.key} (${event.reason}); use cloud.relink if the repository was renamed.`,
        )
      }
      close()
    })
    socket.addEventListener('error', close)
  }
  /** Reconnect after `delay`, or after the backoff, which doubles each time it is used. */
  const schedule = (delay?: number) => {
    reconnect = setTimeout(open, delay ?? retry)
    if (delay === undefined) retry = Math.min(30_000, retry * 2)
  }
  open()
  return Object.assign(
    () => {
      stopped = true
      clearTimeout(reconnect)
      dispose?.()
    },
    {
      idle: async () => {
        await idle?.()
      },
      state: () => state,
      /** Send a lease message on the admitted socket; false while none is. */
      send: (message: MachineMessage) => socketSend?.(message) ?? false,
    },
  )
}

let active: Lease | undefined
/** Sync is configured, but the project has no GitHub origin: it runs here only. */
let localOnly = false
const serving = (host: ExtensionHost) => {
  try {
    host.harness()
    return true
  } catch {
    // Not open yet, or on standby.
    return false
  }
}
/** This machine's name, while sync runs. */
let machine: string | undefined

/** This process's sync role, or undefined while sync is off. */
export function syncState(): SyncState | undefined {
  return active?.sync()?.state()
}

export const actions = {
  /** `{status, machine, role, free, writer, missing, blocked, progress, transition, lastError}` for the cloud UI. */
  state: implementAction(StateAction, async (): Promise<CloudState> =>
    active
      ? { ...(await active.state()), status: 'on', machine }
      : { free: false, missing: [], status: localOnly ? 'local' : 'off' },
  ),
  /**
   * `{force?, by?}`: prepare this machine and take the project, from a free lease or from the online writer. Resolves
   * the transition ID at once; `state` follows its steps. `force` continues although the writer has secrets this
   * machine lacks. `by: 'sync'` records @sync as the move's initiator; otherwise it is this machine's page.
   */
  moveHere: implementAction(MoveHereAction, async (args) => {
    if (!active) throw new Error('Cloud sync is off')
    const { force, by } = (args ?? {}) as { force?: unknown; by?: unknown }
    return active.moveHere({ force: force === true, by: by === 'sync' ? 'sync' : 'local' })
  }),
  /** Back up now: upload a snapshot while this machine keeps the lease; resolves once it is uploaded. */
  backup: implementAction(BackupAction, async () => {
    if (!active) throw new Error('Cloud sync is off')
    return active.backup()
  }),
  /** Stop the preparing move, until its claim is sent. */
  cancel: implementAction(CancelAction, async () => {
    if (!active) throw new Error('Cloud sync is off')
    active.cancel()
    return { ok: true }
  }),
  /**
   * `{from}`: sync this project's key to the replica of `from` from now on, after a repository rename or a root-commit
   * mismatch. The cloud names the epoch again on the next hello.
   */
  relink: async (args: JsonValue, { host }: ActionContext) => {
    const from = (args as { from?: unknown } | null)?.from
    if (typeof from !== 'string' || !PROJECT_KEY.test(from))
      throw new Error('Expected {from: "github.com/<owner>/<repo>"}')
    const config = await cloudConfig(host)
    const identity = await projectIdentity(host.projectRoot)
    if (!config || !identity) throw new Error('Cloud sync is off')
    if (from === identity.key) throw new Error(`${from} is this project's own key`)
    const endpoint = new URL(config.url)
    endpoint.protocol = endpoint.protocol === 'ws:' ? 'http:' : 'https:'
    endpoint.pathname = '/sync/relink'
    endpoint.search = ''
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: identity.key, from }),
    })
    if (!response.ok) throw new Error(`Relink failed: ${response.status} ${await response.text()}`)
    // The epoch was another replica's; without one the writer machine is the writer again.
    const lease = join(host.home, 'cloud-lease.json')
    const held = JSON.parse(await readFile(lease, 'utf8').catch(() => '{}')) as { key?: string }
    if (held.key === identity.key) await rm(lease)
    active?.restart()
    return { key: identity.key, from }
  },
}
export const userActions = ['moveHere', 'cancel', 'relink', 'backup']

/**
 * With cloud sync on, a home opens storage only as this project's writer: one whose `cloud-lease.json` names `key`.
 * Any other home, new or holding a database the cloud never admitted, starts on standby until the cloud names its
 * role, however long that takes, so a machine the cloud did not admit never writes. As the first machine of a new
 * project the lease activates it as the writer, with its own database. Runs before the server opens storage. True
 * when this home starts on standby.
 */
export async function joinOnStandby(home: string, key: string) {
  const path = join(home, 'standby.json')
  if (existsSync(path)) return false
  try {
    const lease = JSON.parse(await readFile(join(home, 'cloud-lease.json'), 'utf8')) as {
      key?: unknown
    }
    if (lease.key === key) return false
  } catch {
    // No lease file: this home never held the project's lease.
  }
  await writeFile(
    `${path}.tmp`,
    JSON.stringify({ reason: 'Waiting for the cloud', joining: true, cloud: true }),
  )
  await rename(`${path}.tmp`, path)
  return true
}

export default async function cloud(host: ExtensionHost, deps: Partial<LeaseDeps> = {}) {
  // Optional services, resolved where they are called; declared here so the catalogue lists them.
  host.want(HealthApi)
  host.want(Feedback)
  host.want(TailscaleApi)
  host.want(PauseApi)
  // The process stopping, not a reload of this facet, releases the lease.
  const stopping = host.resource('cloud.process', () => {
    const current: { lease?: Lease } = {}
    host.onClose(async () => current.lease?.stopRelease())
    return current
  })
  let lease: Lease | undefined
  let closed = false
  const ready = (async () => {
    const config = await cloudConfig(host)
    if (!config) return
    const identity = await projectIdentity(host.projectRoot)
    if (!identity) {
      localOnly = true
      host.notice(`Cloud sync is off: ${host.projectRoot} has no GitHub origin remote.`)
      return
    }
    if (closed) return
    // A reload of this facet while storage is open changes nothing.
    if (!serving(host)) await joinOnStandby(host.home, identity.key)
    machine = config.machine
    lease = startLease(
      host,
      { ...config, identity, ...(await leaseSettings(host)) },
      { sync: startSync, dial: connect, snapshots: snapshot, ...deps },
    )
    stopping.lease = active = lease
  })()
  host.onOpen(async () => {
    await ready
    lease?.opened()
  })
  host.onRelease(async () => {
    await ready
    lease?.released()
  })
  host.onClose(async () => {
    closed = true
    await ready
    lease?.close()
    if (active === lease) active = machine = undefined
    localOnly = false
    await lease?.sync()?.idle()
  })
  // A joining machine is on standby before the server opens storage.
  await ready
  return defineExtension({ name: 'cloud' })
}
