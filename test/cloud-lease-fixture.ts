// Machines, a replica and a project checkout for the lease tests: real Pi storage and git, the replica Durable Object
// over in-process sockets, and kill points that freeze a machine mid-step as a crash would.
import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { R2Bucket } from '@cloudflare/workers-types'
import { defineExtension, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Harness, JsonObject } from '@earendil-works/pi-durable'
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest'
import { SharedReplica } from '../cloud/worker.ts'
import worker from '../cloud/worker.ts'
import type { MachineMessage, Transition } from '../cloud/protocol.ts'
import { ReplicaStore } from '../cloud/replica.ts'
import type { Sql } from '../cloud/replica.ts'
import { startSync } from '../extensions/cloud/server.ts'
import type { Connect, SyncSocket, SyncState } from '../extensions/cloud/server.ts'
import { startLease } from '../extensions/cloud/lease.ts'
import type { Exec } from '../extensions/cloud/lease.ts'
import * as snapshot from '../extensions/cloud/snapshot.ts'
import { git } from '../lib/git.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp, until } from './helpers.ts'

export const KEY = 'github.com/o/project'
const ROOT_COMMIT = 'a'.repeat(40)
export const MINUTE = 60_000

/** An SQL adapter over node:sqlite, as Durable Objects provide. */
export function sql(): Sql {
  const db = new DatabaseSync(':memory:')
  return {
    exec: <T extends Record<string, unknown>>(
      query: string,
      ...bindings: (string | number | null)[]
    ) => {
      const statement = db.prepare(query)
      if (statement.columns().length) return statement.all(...bindings) as T[]
      statement.run(...bindings)
      return []
    },
    transaction: (run) => {
      db.exec('BEGIN')
      try {
        const result = run()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

/** An in-memory R2 bucket for the Worker's snapshot routes. */
function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>()
  return {
    async put(name: string, value: Uint8Array) {
      objects.set(name, { bytes: new Uint8Array(value), uploaded: new Date() })
    },
    async get(name: string) {
      const object = objects.get(name)
      return object ? { body: object.bytes } : null
    },
    async delete(names: string | string[]) {
      for (const name of [names].flat()) objects.delete(name)
    },
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...objects.keys()]
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ key: name, uploaded: objects.get(name)!.uploaded })),
        truncated: false,
      }
    },
  }
}

type Server = ReturnType<SharedReplica['sockets']>[number]
const machineOf = (socket: { deserializeAttachment(): unknown }) =>
  (socket.deserializeAttachment() as { machine?: string } | null)?.machine
/** The project's replica, reached over in-process sockets that deliver each message on a later microtask. */
export function cloud({ aliases = {} }: { aliases?: Record<string, string> } = {}) {
  const sockets: Server[] = []
  /** How a machine's next message of a type is delivered: not at all, or with every later reply lost. */
  const holds: {
    machine: string
    type: MachineMessage['type']
    how: 'drop' | 'mute'
    /** Resolves once the message was held. */
    hit: PromiseWithResolvers<void>
  }[] = []
  const replica = Object.assign(Object.create(SharedReplica.prototype) as SharedReplica, {
    store: new ReplicaStore(sql()),
    ctx: { getWebSockets: () => sockets, waitUntil: () => {} },
    env: {
      DIRECTORY: {
        idFromName: () => 'directory',
        get: () => ({ fetch: async () => new Response() }),
      },
    },
  })
  const dial: Connect = (url) => {
    const client = new EventTarget() as EventTarget & SyncSocket
    // A relinked key reaches its target's replica, as the Worker's sync route sends it.
    const requested = new URL(url).searchParams.get('project')!
    let attachment: unknown = aliases[requested]
      ? { key: aliases[requested], alias: requested }
      : { key: requested }
    let muted = false
    const server = {
      readyState: WebSocket.OPEN as number,
      send: (data: string) =>
        queueMicrotask(() => {
          if (server.readyState === WebSocket.OPEN && !muted)
            client.dispatchEvent(new MessageEvent('message', { data }))
        }),
      close: (code?: number, reason?: string) => {
        if (server.readyState !== WebSocket.OPEN) return
        server.readyState = WebSocket.CLOSED
        queueMicrotask(() =>
          client.dispatchEvent(Object.assign(new Event('close'), { code, reason })),
        )
      },
      serializeAttachment: (value: unknown) => {
        attachment = value
      },
      deserializeAttachment: () => attachment,
    }
    // The sender sends JSON text, and `ping`, which the replica's auto-response answers without waking it.
    client.send = (data) =>
      queueMicrotask(() => {
        if (server.readyState !== WebSocket.OPEN) return
        if (data === 'ping') {
          if (!muted) client.dispatchEvent(new MessageEvent('message', { data: 'pong' }))
          return
        }
        const { type } = JSON.parse(data as string) as MachineMessage
        const hold = holds.findIndex(
          (item) => item.machine === machineOf(server) && item.type === type,
        )
        const held = hold < 0 ? undefined : holds.splice(hold, 1)[0]
        if (held?.how !== 'drop')
          replica.webSocketMessage(server as unknown as Server, data as string)
        if (held?.how === 'mute') muted = true
        held?.hit.resolve()
      })
    client.close = () => {
      if (server.readyState !== WebSocket.OPEN) return
      server.readyState = WebSocket.CLOSED
      replica.webSocketClose(server as unknown as Server)
    }
    sockets.push(server as unknown as Server)
    queueMicrotask(() => client.dispatchEvent(new Event('open')))
    return client
  }
  /** Drop every socket of machine `name` from the cloud's side, as a lost network does. */
  const drop = (name: string) => {
    for (const socket of sockets)
      if (machineOf(socket) === name) {
        socket.close(1006, 'gone')
        replica.webSocketClose(socket)
      }
  }
  /** A request to the replica's own routes, as the Worker's bearer routes send it. */
  const api = (path: string, body?: unknown) =>
    replica.fetch(
      new Request(`https://cloud.example${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  /**
   * The next `type` message from `machine` never arrives (`drop`), or arrives and every later reply on that socket is
   * lost (`mute`): a crash before or after the cloud acted on it.
   */
  const hold = (name: string, type: MachineMessage['type'], how: 'drop' | 'mute') => {
    const hit = Promise.withResolvers<void>()
    holds.push({ machine: name, type, how, hit })
    return hit.promise
  }
  /** At most one writer: the lease's machine with its socket, or a free lease with a snapshot. */
  const settled = () => {
    const lease = replica.store.lease()!
    const writers = replica.sockets().map(machineOf)
    return lease.machine === null
      ? writers.length === 0 && !!lease.snapshot
      : writers.length === 1 && writers[0] === lease.machine
  }
  return { replica, dial, drop, api, hold, settled }
}

/** A durable task that sleeps for a day: in the background it leaves the writer idle, in the foreground it is work. */
const Sleeper = defineTask<null, { phase: 'sleep' }, null>({
  name: 'lease-test.sleeper',
  version: 1,
  initial: () => ({ phase: 'sleep' }),
  phases: {
    sleep: async (_task, runtime, ctx) => {
      await runtime.sleep(runtime.now() + 24 * 60 * MINUTE, ctx)
      return runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        ctx,
      )
    },
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
})
export const sleep = (harness: Harness, background: boolean) =>
  harness.commit(
    (tx) =>
      tx.createTask(Sleeper, null, {
        conversationId: ROOT_CONVERSATION_ID,
        ownership: { kind: 'conversation' },
        background,
      }),
    context,
  )

/** Conversations, entries and live tasks, which a move must carry over unchanged. */
export async function inventory(harness: Harness) {
  const conversations = await harness.commit(
    async (tx) => (await tx.scanConversations({}, 256)).items.map((record) => record.id),
    context,
  )
  let entries = 0
  for (const id of conversations)
    entries += await harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: id }, 1000)).items.length,
      context,
    )
  const graph = await harness.taskGraph(context)
  const tasks = Object.values(graph.value.tasks).map((task) => [task.kind, task.background])
  graph.dispose()
  return { conversations, entries, tasks }
}
/** Some history to move: a second conversation and an entry in each. */
export const seed = (harness: Harness) =>
  harness.commit(async (tx) => {
    const other = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    for (const id of [ROOT_CONVERSATION_ID, other.id])
      await tx.appendEntry(id, { kind: 'lease-test.entry', data: { id } })
  }, context)

/** A home with a database of its own, written before this machine knew the cloud, and no lease file. */
export async function ownHistory() {
  const home = await temp('ultimate-lease-own-')
  const prepared = await prepareHarness({ ultimateRoot: home, userHome: home, home, faux: true })
  const opened = await prepared.open(false)
  await seed(opened.harness)
  const before = await inventory(opened.harness)
  await opened.close()
  return { home, before }
}

export const author = ['-c', 'user.name=T', '-c', 'user.email=t@example.com']
/** A GitHub-like origin with one commit on main, a clone of it as the project checkout, and a way to push to it. */
export async function checkout() {
  const upstream = await temp('ultimate-lease-upstream-')
  await git(upstream, 'init', '-q', '-b', 'main')
  await writeFile(join(upstream, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(upstream, 'README.md'), 'project\n')
  await git(upstream, 'add', '.')
  await git(upstream, ...author, 'commit', '-q', '-m', 'root')
  const origin = join(await temp('ultimate-lease-origin-'), 'origin.git')
  await git(upstream, 'clone', '-q', '--bare', upstream, origin)
  await git(upstream, 'remote', 'add', 'origin', origin)
  const root = join(await temp('ultimate-lease-checkout-'), 'project')
  await git(upstream, 'clone', '-q', origin, root)
  return {
    root,
    /** Commit `files` upstream and push them. */
    async push(files: Record<string, string>) {
      for (const [name, text] of Object.entries(files)) await writeFile(join(upstream, name), text)
      await git(upstream, 'add', '.')
      await git(upstream, ...author, 'commit', '-q', '-m', 'change')
      await git(upstream, 'push', '-q', 'origin', 'main')
      return git(upstream, 'rev-parse', 'HEAD')
    },
  }
}

const bucket = memoryBucket()
const machines = new Set<{ close(): Promise<void> }>()
beforeAll(() => {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
})
afterEach(async () => {
  // Taken out of the set first: a close that hangs fails this test's hook once, not every later test's.
  const running = [...machines]
  machines.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(running.map((each) => each.close()))
})
afterAll(() => {
  Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
})
export const toWorker = (input: string | URL, init?: RequestInit) =>
  worker.fetch(new Request(input, init), {
    SYNC_TOKEN: 'dev',
    BUILDS: bucket as unknown as R2Bucket,
  } as Parameters<typeof worker.fetch>[1])
export const snapshotFetch = () => vi.stubGlobal('fetch', toWorker)

/**
 * Where a machine freezes, as a crash would, until `crash()` takes it down: right after the fast-forward, running pnpm
 * (after fetch), in the checks
 * (after install), with a download finished, at the start of a release's upload, or opening storage after a claim.
 */
export type KillPoint = 'merged' | 'pnpm' | 'checks' | 'download' | 'upload' | 'activate'
const never = () => new Promise<never>(() => {})
/** A dead socket for a crashed machine: it never opens. */
const dead = () =>
  Object.assign(new EventTarget(), { send: () => {}, close: () => {} }) as unknown as SyncSocket

/**
 * One machine's process for the project: real Pi storage in `home`, and the server's standby switches as core runs
 * them. It starts on standby when `standby.json` exists, as the server does. Git runs for real; pnpm is recorded.
 */
export async function machine(
  name: string,
  project: ReturnType<typeof cloud>,
  root: string,
  options: {
    home?: string
    snapshots?: typeof snapshot
    autoClaim?: boolean
    pnpm?: () => Promise<void>
    kill?: KillPoint
    /** The project key this checkout connects with. */
    key?: string
    /** The cloud never answers. */
    offline?: boolean
    /** The first activation that installs fails: parking the local database, renaming the download, or opening. */
    fail?: 'park' | 'rename' | 'open'
    /** Runs before each git command, which waits for it: a test can hold one. */
    git?: (args: readonly string[]) => Promise<void>
    /** The model login; faux hosts have one. */
    login?: { provider: string; ok: boolean }
  } = {},
) {
  const home = options.home ?? (await temp('ultimate-lease-'))
  const prepared = await prepareHarness({ ultimateRoot: home, userHome: home, home, faux: true })
  prepared.registry.install(defineExtension({ name: 'lease-test', tasks: [Sleeper] }))
  const standbyFile = join(home, 'standby.json')
  let opened = existsSync(standbyFile) ? undefined : await prepared.open()
  let standby = opened ? undefined : (JSON.parse(await readFile(standbyFile, 'utf8')) as JsonObject)
  const openers = new Set<() => Promise<void>>()
  const releasers = new Set<() => Promise<void>>()
  const notices: string[] = []
  const roles: SyncState[] = []
  const installs: string[][] = []
  // A crashed machine does nothing more: its sockets stay dead and its switches never finish.
  let killed = false
  let failed = false
  const reached = Promise.withResolvers<void>()
  const at = async (point: KillPoint) => {
    if (options.kill !== point && !killed) return
    reached.resolve()
    await never()
  }
  let switching = Promise.resolve()
  const serial = (work: () => Promise<void>) => {
    const next = switching.then(work)
    switching = next.catch(() => undefined)
    return next
  }
  const host = {
    ...prepared,
    projectRoot: root,
    harness: () => {
      if (!opened) throw new Error('Harness is not open')
      return opened.harness
    },
    standby: () => standby,
    deactivate: (info, park) =>
      killed
        ? never()
        : serial(async () => {
            if (standby || !opened) return
            for (const release of releasers) await release()
            await opened.close()
            opened = undefined
            await writeFile(standbyFile, JSON.stringify(info))
            standby = info
            await park?.(prepared.database)
          }),
    activate: async (install) => {
      await at('activate')
      return serial(async () => {
        if (!standby) return
        if (options.fail && install && !failed) {
          failed = true
          if (options.fail === 'open') {
            await install(prepared.database)
            throw new Error('Opening storage failed')
          }
          // A read-only home: parking renames the local database, installing renames the download into place.
          await chmod(home, 0o555)
          try {
            await install(prepared.database)
          } finally {
            await chmod(home, 0o755)
          }
        }
        await install?.(prepared.database)
        await rm(standbyFile)
        opened = await prepared.open()
        standby = undefined
        for (const open of openers) await open()
      })
    },
    onOpen: (callback) => openers.add(callback),
    onRelease: (callback) => releasers.add(callback),
    want: () => undefined,
    conversations: () => [],
    system: () =>
      ({ process: { url: 'http://127.0.0.1:4800' } }) as unknown as ReturnType<
        ExtensionHost['system']
      >,
    build: () => ({ id: 'test-build' }) as ReturnType<ExtensionHost['build']>,
    notice: (message: string) => {
      notices.push(message)
    },
  } satisfies Partial<ExtensionHost> as unknown as ExtensionHost
  const snapshots = options.snapshots ?? {
    ...snapshot,
    uploadSnapshot: vi.fn<typeof snapshot.uploadSnapshot>(async (o) => {
      await at('upload')
      return snapshot.uploadSnapshot(o)
    }),
    downloadSnapshot: vi.fn<typeof snapshot.downloadSnapshot>(async (o) => {
      const result = await snapshot.downloadSnapshot(o)
      await at('download')
      return result
    }),
  }
  const exec: Exec = async (command, args, execOptions) => {
    if (killed) return never()
    if (command === 'git') {
      await options.git?.(args)
      const stdout = await git(execOptions.cwd, ...args)
      if (args[0] === 'merge') await at('merged')
      return { stdout, stderr: '' }
    }
    installs.push([command, ...args])
    await at('pnpm')
    await options.pnpm?.()
    return { stdout: '', stderr: '' }
  }
  const lease = startLease(
    host,
    {
      url: 'ws://127.0.0.1:8787',
      token: 'dev',
      machine: name,
      identity: { key: options.key ?? KEY, rootCommit: ROOT_COMMIT },
      idleRelease: 10,
      autoClaim: options.autoClaim ?? true,
    },
    {
      // Every role this machine hears, for what reaches each socket.
      sync: (syncHost, syncOptions, syncDial, hooks) =>
        startSync(syncHost, syncOptions, syncDial, {
          ...hooks!,
          role: (state) => {
            roles.push(structuredClone(state))
            hooks!.role?.(state)
          },
        }),
      dial: (url, token) => (killed || options.offline ? dead() : project.dial(url, token)),
      snapshots,
      exec,
      secret: async () => {
        await at('checks')
        return 'snapshot secret'
      },
      ...(options.login ? { login: async () => options.login! } : {}),
    },
  )
  host.onOpen(async () => lease.opened())
  host.onRelease(async () => lease.released())
  if (opened) lease.opened()
  const handle = {
    home,
    host,
    lease,
    notices,
    roles,
    installs,
    snapshots,
    /** Resolves once the machine froze at its kill point. */
    reached: reached.promise,
    harness: () => host.harness(),
    serving: () => !!opened,
    role: () => lease.sync()?.state(),
    leaseFile: async () => JSON.parse(await readFile(join(home, 'cloud-lease.json'), 'utf8')),
    /** The databases and downloads in the home, without their `-wal` and `-shm`. */
    files: async () =>
      (await readdir(home))
        .filter((file) => /^(state|snapshot)\..*sqlite$|^snapshot-|^\.snapshot-/.test(file))
        .toSorted(),
    async transition() {
      return (await lease.state()).transition
    },
    /** Take the machine down where it is: no cleanup runs, its storage closes, its socket drops. */
    async crash() {
      killed = true
      machines.delete(handle)
      lease.sync()?.()
      await opened?.close()
      opened = undefined
    },
    async close() {
      lease.close()
      await lease.settled()
      await switching
      await opened?.close()
      opened = undefined
    },
  }
  machines.add(handle)
  return handle
}
export type Machine = Awaited<ReturnType<typeof machine>>
export const writer = (m: Machine) =>
  until(() => !!m.role()?.connected && m.role()?.role === 'writer' && m.serving())
/** On standby with its standby connection admitted, and no lifecycle work left. */
export const standbyOn = (m: Machine) =>
  until(async () => {
    await m.lease.settled()
    return !!m.role()?.connected && m.role()?.role === 'standby' && !!m.host.standby()
  })
/** Release an idle writer through the idle timer: idle at `start`, released ten minutes on. */
export async function idleRelease(m: Machine, start = Date.now()) {
  expect(await m.lease.checkIdle(start)).toBe(false)
  expect(await m.lease.checkIdle(start + 10 * MINUTE)).toBe(true)
}
export const states = (transition: Transition | undefined) =>
  Object.fromEntries(transition?.steps.map((step) => [step.name, step.state]) ?? [])
