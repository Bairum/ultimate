import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { R2Bucket } from '@cloudflare/workers-types'
import { defineExtension, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Harness, JsonObject } from '@earendil-works/pi-durable'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ProjectDirectory, SharedReplica } from '../cloud/worker.ts'
import worker from '../cloud/worker.ts'
import { DirectoryStore } from '../cloud/directory.ts'
import type { Transition } from '../cloud/protocol.ts'
import { ReplicaStore } from '../cloud/replica.ts'
import type { Sql } from '../cloud/replica.ts'
import { actions, joinOnStandby, startSync } from '../extensions/cloud/server.ts'
import type { Connect, SyncSocket, SyncState } from '../extensions/cloud/server.ts'
import { startLease } from '../extensions/cloud/lease.ts'
import type { Exec } from '../extensions/cloud/lease.ts'
import * as snapshot from '../extensions/cloud/snapshot.ts'
import { git } from '../extensions/workspaces/git.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import { temp, until } from './helpers.ts'

const KEY = 'github.com/o/project'
const ROOT_COMMIT = 'a'.repeat(40)
const MINUTE = 60_000

/** An SQL adapter over node:sqlite, as Durable Objects provide. */
function sql(): Sql {
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
/** The project's replica, reached over in-process sockets that deliver each message on a later microtask. */
function cloud() {
  const sockets: Server[] = []
  const replica = Object.assign(Object.create(SharedReplica.prototype) as SharedReplica, {
    store: new ReplicaStore(sql()),
    streams: new Set(),
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
    let attachment: unknown = { key: new URL(url).searchParams.get('project') }
    const server = {
      readyState: WebSocket.OPEN as number,
      send: (data: string) =>
        queueMicrotask(() => {
          if (server.readyState === WebSocket.OPEN)
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
    // The sender only sends JSON text.
    client.send = (data) =>
      queueMicrotask(() => {
        if (server.readyState === WebSocket.OPEN)
          replica.webSocketMessage(server as unknown as Server, data as string)
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
      if ((socket.deserializeAttachment() as { machine?: string }).machine === name) {
        socket.close(1006, 'gone')
        replica.webSocketClose(socket)
      }
  }
  /** A request to the project's API, as the cloud UI sends it. */
  const api = (path: string, body?: unknown) =>
    replica.fetch(
      new Request(`https://cloud.example${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { replica, dial, drop, api }
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
const sleep = (harness: Harness, background: boolean) =>
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
async function inventory(harness: Harness) {
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

const author = ['-c', 'user.name=T', '-c', 'user.email=t@example.com']
/** A GitHub-like origin with one commit on main, a clone of it as the project checkout, and a way to push to it. */
async function checkout() {
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
const machines: { close(): Promise<void> }[] = []
beforeAll(() => {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: timingSafeEqual,
  })
})
afterEach(async () => {
  for (const running of machines.splice(0)) await running.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
afterAll(() => {
  Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual')
})
const toWorker = (input: string | URL, init?: RequestInit) =>
  worker.fetch(new Request(input, init), {
    SYNC_TOKEN: 'dev',
    BUILDS: bucket as unknown as R2Bucket,
  } as Parameters<typeof worker.fetch>[1])
const snapshotFetch = () => vi.stubGlobal('fetch', toWorker)

/**
 * One machine's process for the project: real Pi storage in `home`, and the server's standby switches as core runs
 * them. It starts on standby when `standby.json` exists, as the server does. Git runs for real; pnpm is recorded.
 */
async function machine(
  name: string,
  { dial }: ReturnType<typeof cloud>,
  root: string,
  options: {
    home?: string
    snapshots?: typeof snapshot
    autoClaim?: boolean
    pnpm?: () => Promise<void>
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
      serial(async () => {
        if (standby || !opened) return
        for (const release of releasers) await release()
        await opened.close()
        opened = undefined
        await writeFile(standbyFile, JSON.stringify(info))
        standby = info
        await park?.(prepared.database)
      }),
    activate: (install) =>
      serial(async () => {
        if (!standby) return
        await install?.(prepared.database)
        await rm(standbyFile)
        opened = await prepared.open()
        standby = undefined
        for (const open of openers) await open()
      }),
    onOpen: (callback) => openers.add(callback),
    onRelease: (callback) => releasers.add(callback),
    use: () => undefined,
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
    uploadSnapshot: vi.fn<typeof snapshot.uploadSnapshot>(snapshot.uploadSnapshot),
    downloadSnapshot: vi.fn<typeof snapshot.downloadSnapshot>(snapshot.downloadSnapshot),
  }
  const exec: Exec = async (command, args, execOptions) => {
    if (command === 'git') return { stdout: await git(execOptions.cwd, ...args), stderr: '' }
    installs.push([command, ...args])
    await options.pnpm?.()
    return { stdout: '', stderr: '' }
  }
  const lease = startLease(
    host,
    {
      url: 'ws://127.0.0.1:8787',
      token: 'dev',
      machine: name,
      identity: { key: KEY, rootCommit: ROOT_COMMIT },
      idleRelease: 10,
      autoClaim: options.autoClaim ?? true,
    },
    {
      // Every role this machine hears, for what reaches each socket.
      sync: (syncHost, syncOptions, syncDial, builds, hooks) =>
        startSync(syncHost, syncOptions, syncDial, builds, {
          ...hooks!,
          role: (state) => {
            roles.push(structuredClone(state))
            hooks!.role?.(state)
          },
        }),
      dial,
      snapshots,
      exec,
      secret: async () => 'snapshot secret',
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
    harness: () => host.harness(),
    serving: () => !!opened,
    role: () => lease.sync()?.state(),
    leaseFile: async () => JSON.parse(await readFile(join(home, 'cloud-lease.json'), 'utf8')),
    /** The databases in the home, without their `-wal` and `-shm`. */
    files: async () =>
      (await readdir(home))
        .filter((file) => /^(state|snapshot)\..*sqlite$|^snapshot-/.test(file))
        .toSorted(),
    async transition() {
      return (await lease.state()).transition
    },
    async close() {
      lease.close()
      await lease.settled()
      await switching
      await opened?.close()
      opened = undefined
    },
  }
  machines.push(handle)
  return handle
}
type Machine = Awaited<ReturnType<typeof machine>>
const writer = (m: Machine) =>
  until(() => !!m.role()?.connected && m.role()?.role === 'writer' && m.serving())
/** On standby with its standby connection admitted, and no lifecycle work left. */
const standbyOn = (m: Machine) =>
  until(async () => {
    await m.lease.settled()
    return !!m.role()?.connected && m.role()?.role === 'standby' && !!m.host.standby()
  })
/** Release an idle writer through the idle timer: idle at `start`, released ten minutes on. */
async function idleRelease(m: Machine, start = Date.now()) {
  expect(await m.lease.checkIdle(start)).toBe(false)
  expect(await m.lease.checkIdle(start + 10 * MINUTE)).toBe(true)
}
const states = (transition: Transition | undefined) =>
  Object.fromEntries(transition?.steps.map((step) => [step.name, step.state]) ?? [])

it('releases an idle writer, and another machine prepares and takes over the same history', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  const laptop = await machine('laptop', project, root)
  // A machine new to the project starts serving its fresh database, hears it is a standby, and closes storage.
  await standbyOn(laptop)
  expect(laptop.host.standby()).toMatchObject({ reason: 'Runs on desk', cloud: true, free: false })
  expect(await laptop.files()).toEqual([expect.stringMatching(/^state\.stale-.+\.sqlite$/)])

  await desk.harness().commit(async (tx) => {
    const other = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    for (const id of [ROOT_CONVERSATION_ID, other.id])
      await tx.appendEntry(id, { kind: 'lease-test.entry', data: { id } })
  }, context)
  await sleep(desk.harness(), true)
  const before = await inventory(desk.harness())
  expect(before.tasks).toEqual([['lease-test.sleeper', true]])

  await idleRelease(desk)
  expect(desk.host.standby()).toMatchObject({ reason: 'Released · resume here', released: true })
  expect(await desk.files()).toEqual(['state.sqlite'])
  const released = project.replica.store.lease()!
  expect(released).toMatchObject({ machine: null, epoch: 1, snapshot: { epoch: 1 } })
  expect(await desk.leaseFile()).toEqual({
    key: KEY,
    epoch: 1,
    snapshot: released.snapshot!.id,
    snapshotHash: await snapshot.databaseHash(join(desk.home, 'state.sqlite')),
  })
  // The laptop is not starting, so it waits for "Move here".
  await until(() => !!laptop.role()?.free)
  expect(laptop.serving()).toBe(false)
  expect(await laptop.lease.state()).toMatchObject({ role: 'standby', free: true, missing: [] })

  expect(await laptop.lease.move()).toBe(true)
  await writer(laptop)
  expect(laptop.snapshots.downloadSnapshot).toHaveBeenCalledOnce()
  expect(await inventory(laptop.harness())).toEqual(before)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
  expect(await laptop.leaseFile()).toEqual({ key: KEY, epoch: 2 })
  const transition = project.replica.store.transition()!
  expect(transition).toMatchObject({
    target: 'laptop',
    from: null,
    step: 'claim',
    cancellable: false,
  })
  expect(transition.error).toBeUndefined()
  expect(states(transition)).toEqual({
    fetch: 'done',
    install: 'skipped',
    checks: 'done',
    handover: 'skipped',
    download: 'done',
    branches: 'done',
    claim: 'done',
  })
  const download = transition.steps.find((step) => step.name === 'download')!
  expect(download.total).toBeGreaterThan(0)
  expect(download.done).toBe(download.total)
  // The desk keeps its database and hears who runs the project now.
  await until(() => desk.role()?.writer?.machine === 'laptop')
  expect(desk.serving()).toBe(false)
  expect(await desk.files()).toEqual(['state.sqlite'])
})

it('joins on standby: a new project activates its first machine, a known one creates no database', async () => {
  const project = cloud()
  const { root } = await checkout()
  const deskHome = await temp('ultimate-lease-')
  expect(await joinOnStandby(deskHome)).toBe(true)
  const desk = await machine('desk', project, root, { home: deskHome })
  // Nobody knew the project: the cloud registers the joining machine as its writer, which opens a fresh database.
  await writer(desk)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(await desk.leaseFile()).toEqual({ key: KEY, epoch: 1 })
  expect(await desk.files()).toEqual(['state.sqlite'])
  // A serving machine's home is no new one.
  expect(await joinOnStandby(deskHome)).toBe(false)

  const laptopHome = await temp('ultimate-lease-')
  expect(await joinOnStandby(laptopHome)).toBe(true)
  const laptop = await machine('laptop', project, root, { home: laptopHome })
  await standbyOn(laptop)
  expect(laptop.host.standby()).toEqual({ joining: true, cloud: true })
  expect(laptop.serving()).toBe(false)
  expect(await readdir(laptopHome)).toEqual(['standby.json'])
})

it('fast-forwards the checkout and installs when the lockfile changed, rerunning a failed install', async () => {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  const desk = await machine('desk', project, repo.root)
  await writer(desk)
  await idleRelease(desk)
  let failing = true
  const laptop = await machine('laptop', project, repo.root, {
    autoClaim: false,
    pnpm: async () => {
      if (failing)
        throw Object.assign(new Error('exit 1'), {
          stdout: 'Progress\n',
          stderr: 'ERR_PNPM_OUTDATED',
        })
    },
  })
  await standbyOn(laptop)
  const tip = await repo.push({ 'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n' })
  expect(await laptop.lease.move()).toBe(false)
  expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(tip)
  const failed = await laptop.transition()
  expect(states(failed)).toMatchObject({ fetch: 'done', install: 'failed', checks: 'pending' })
  expect(failed?.error).toBe('pnpm install failed:\nProgress\nERR_PNPM_OUTDATED')
  expect(project.replica.store.lease()).toMatchObject({ machine: null, epoch: 1 })
  expect(laptop.serving()).toBe(false)

  failing = false
  expect(await laptop.lease.move()).toBe(true)
  expect(laptop.installs).toEqual([
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', 'install', '--frozen-lockfile'],
  ])
  expect(states(await laptop.transition())).toMatchObject({ fetch: 'done', install: 'done' })
  await writer(laptop)
  expect(existsSync(join(laptop.home, 'cloud-install-pending'))).toBe(false)
})

it('refuses a dirty checkout before asking the writer, leaving the holder untouched', async () => {
  const project = cloud()
  const repo = await checkout()
  const desk = await machine('desk', project, repo.root)
  await writer(desk)
  const laptop = await machine('laptop', project, repo.root)
  await standbyOn(laptop)
  await writeFile(join(repo.root, 'README.md'), 'local change\n')
  expect(await laptop.lease.move()).toBe(false)
  const transition = await laptop.transition()
  expect(transition).toMatchObject({
    error: 'The checkout has uncommitted changes',
    cancellable: false,
  })
  expect(states(transition)).toMatchObject({ fetch: 'failed', handover: 'pending' })
  expect(laptop.notices).toContain('Move here failed: The checkout has uncommitted changes')
  // The cloud and the writer saw the failed transition; the writer was never asked to release.
  await until(() => !!desk.role()?.transition?.error)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(desk.serving()).toBe(true)
  expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
})

it('cancels a move mid-download, removing the download and keeping the lease free', async () => {
  const project = cloud()
  const repo = await checkout()
  await git(repo.root, 'branch', 'ultimate/feature')
  // The branch bundle hangs until the move is cancelled; everything else reaches the Worker.
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
    String(input).includes('/bundle-0') && init?.method === 'GET'
      ? new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        )
      : toWorker(input, init),
  )
  const desk = await machine('desk', project, repo.root)
  await writer(desk)
  await idleRelease(desk)
  const laptop = await machine('laptop', project, repo.root, { autoClaim: false })
  await standbyOn(laptop)
  const moving = laptop.lease.move()
  await until(async () => (await laptop.files()).some((file) => file.startsWith('snapshot-')))
  expect((await laptop.transition())?.step).toBe('download')
  laptop.lease.cancel()
  expect(await moving).toBe(false)
  expect(await laptop.files()).toEqual([expect.stringMatching(/^state\.stale-/)])
  const transition = await laptop.transition()
  expect(transition).toMatchObject({ error: 'Cancelled', cancellable: false })
  expect(states(transition)).toMatchObject({ download: 'failed', claim: 'pending' })
  await until(() => project.replica.store.transition()?.error === 'Cancelled')
  expect(project.replica.store.lease()).toMatchObject({ machine: null, epoch: 1 })
  expect(laptop.serving()).toBe(false)
  expect(() => laptop.lease.cancel()).toThrow('No move to cancel')
})

it('moves from the cloud UI: the online writer drains, and every step reaches its socket', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  const task = await sleep(desk.harness(), false)
  const laptop = await machine('laptop', project, root)
  await standbyOn(laptop)
  const response = await project.api('/api/cloud/move', { machine: 'laptop' })
  expect(response.status).toBe(202)
  const { id } = (await response.json()) as { id: string }
  const waiting = 'Move to laptop waits for 1 running task'
  await until(() => desk.notices.includes(waiting) && laptop.notices.includes(waiting))
  // The writer's own socket hears the handover it is draining for.
  await until(() =>
    desk.roles.some(
      (state) =>
        state.role === 'writer' &&
        state.transition?.id === id &&
        state.transition.steps.some((step) => step.detail === 'finishing 1 run'),
    ),
  )
  expect(desk.serving()).toBe(true)
  expect(
    ((await (await project.api('/api/cloud')).json()) as { transition: Transition }).transition,
  ).toMatchObject({ id, target: 'laptop', from: 'desk', step: 'handover', cancellable: true })
  await desk.harness().abortTask(task, context)
  await writer(laptop)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
  expect(desk.host.standby()).toMatchObject({ reason: 'Moved to laptop' })
  expect(states(project.replica.store.transition())).toMatchObject({
    handover: 'done',
    download: 'done',
    claim: 'done',
  })
  await until(() => desk.roles.at(-1)?.transition?.steps.at(-1)?.state === 'done')
})

it('cancels from the cloud UI during the handover, and the draining writer keeps the project', async () => {
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  await sleep(desk.harness(), false)
  const laptop = await machine('laptop', project, root)
  await standbyOn(laptop)
  const { id } = laptop.lease.moveHere()
  await until(() => desk.notices.includes('Move to laptop waits for 1 running task'))
  expect((await project.api('/api/cloud/cancel', {})).status).toBe(202)
  await until(() =>
    desk.notices.includes('The move to laptop stopped; this machine keeps the project'),
  )
  expect(await laptop.transition()).toMatchObject({ id, error: 'Cancelled' })
  expect(states(await laptop.transition())).toMatchObject({ handover: 'failed' })
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(desk.serving()).toBe(true)
  expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
})

it('keeps the lease and keeps serving while busy, also when its connection drops', async () => {
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  await sleep(desk.harness(), false)
  const start = Date.now()
  expect(await desk.lease.checkIdle(start)).toBe(false)
  expect(await desk.lease.checkIdle(start + 60 * MINUTE)).toBe(false)
  const laptop = await machine('laptop', project, root)
  await standbyOn(laptop)
  project.drop('desk')
  await until(() => laptop.role()?.writer?.online === false)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(desk.serving()).toBe(true)
  expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
  expect(() => laptop.lease.moveHere()).toThrow('desk is offline')
})

it('returns an old holder to standby, parking its database only when it changed', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  await idleRelease(desk)
  const laptop = await machine('laptop', project, root)
  // A starting machine claims the free lease by itself.
  await writer(laptop)
  await desk.close()
  // The desk returns with the released database in place: standby, nothing parked.
  await rm(join(desk.home, 'standby.json'))
  const unchanged = await machine('desk', project, root, { home: desk.home })
  await standbyOn(unchanged)
  expect(await unchanged.files()).toEqual(['state.sqlite'])
  await unchanged.close()

  // Written to since the release: that history is parked aside, never lost.
  await rm(join(desk.home, 'standby.json'))
  const local = await prepareHarness({
    ultimateRoot: desk.home,
    userHome: desk.home,
    home: desk.home,
    faux: true,
  })
  const opened = await local.open(false)
  const entry = await opened.harness.commit(
    (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: 'lease-test.local', data: {} }),
    context,
  )
  await opened.close()
  const changed = await machine('desk', project, root, { home: desk.home })
  await standbyOn(changed)
  const files = await changed.files()
  expect(files).not.toContain('state.sqlite')
  const stale = files.find((file) => /^state\.stale-.+\.sqlite$/.test(file))!
  const kept = await temp('ultimate-lease-kept-')
  for (const file of (await readdir(desk.home)).filter((name) => name.startsWith(stale)))
    await copyFile(join(desk.home, file), join(kept, file.replace(stale, 'state.sqlite')))
  const reopened = await (
    await prepareHarness({ ultimateRoot: kept, userHome: kept, home: kept, faux: true })
  ).open(false)
  try {
    const ids = await reopened.harness.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100)).items.map(
          (item) => item.id,
        ),
      context,
    )
    expect(ids).toContain(entry.id)
  } finally {
    await reopened.close()
  }
})

it('claims its own released snapshot on start without downloading it', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  await desk
    .harness()
    .commit(
      (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: 'lease-test.entry', data: {} }),
      context,
    )
  const before = await inventory(desk.harness())
  await idleRelease(desk)
  await desk.close()
  const restarted = await machine('desk', project, root, { home: desk.home })
  await writer(restarted)
  expect(restarted.snapshots.downloadSnapshot).not.toHaveBeenCalled()
  expect(states(await restarted.transition())).toMatchObject({ download: 'skipped', claim: 'done' })
  expect(await inventory(restarted.harness())).toEqual(before)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 2 })
  expect(await restarted.files()).toEqual(['state.sqlite'])
})

it('releases on a clean stop, and a failed upload keeps the lease and opens normally next time', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  desk.lease.close()
  await desk.lease.stopRelease()
  expect(project.replica.store.lease()).toMatchObject({ machine: null, epoch: 1 })
  expect(existsSync(join(desk.home, 'standby.json'))).toBe(true)

  const other = cloud()
  const offline = {
    ...snapshot,
    uploadSnapshot: vi.fn<typeof snapshot.uploadSnapshot>(async () => {
      throw new Error('network is unreachable')
    }),
  }
  const laptop = await machine('laptop', other, root, { snapshots: offline })
  await writer(laptop)
  laptop.lease.close()
  await laptop.lease.stopRelease()
  expect(laptop.notices).toEqual([
    'Releasing the lease failed; this machine keeps it: Error: network is unreachable',
  ])
  expect(other.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 1 })
  expect(existsSync(join(laptop.home, 'standby.json'))).toBe(false)
  await laptop.close()
  const restarted = await machine('laptop', other, root, { home: laptop.home })
  expect(restarted.serving()).toBe(true)
  await writer(restarted)
})

it('refuses to claim when the writer runs the project at another root', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  await idleRelease(desk)
  const elsewhere = await temp('ultimate-lease-elsewhere-')
  const laptop = await machine('laptop', project, elsewhere)
  // The automatic claim on start is refused too.
  await standbyOn(laptop)
  const reason = `The project runs at ${root}; this checkout is ${elsewhere}`
  await until(() => laptop.notices.includes(`Move here refused: ${reason}`))
  expect((await laptop.lease.state()).blocked).toBe(reason)
  expect(() => laptop.lease.moveHere()).toThrow(reason)
  expect(laptop.snapshots.downloadSnapshot).not.toHaveBeenCalled()
  expect(project.replica.store.lease()).toMatchObject({ machine: null, epoch: 1 })
})

it('relinks a renamed repository to its old replica and forgets the lease epoch', async () => {
  const root = await temp('ultimate-lease-relink-')
  await git(root, 'init', '-q', '-b', 'main')
  await git(root, ...author, 'commit', '-q', '--allow-empty', '-m', 'root')
  await git(root, 'remote', 'add', 'origin', 'git@github.com:o/renamed.git')
  const home = await temp('ultimate-lease-relink-home-')
  await writeFile(
    join(home, 'cloud-lease.json'),
    JSON.stringify({ key: 'github.com/o/renamed', epoch: 1 }),
  )
  const store = new DirectoryStore(sql())
  const directory = Object.assign(Object.create(ProjectDirectory.prototype) as ProjectDirectory, {
    store,
  })
  vi.stubEnv('ULTIMATE_CLOUD_URL', 'ws://127.0.0.1:8787')
  vi.stubEnv('ULTIMATE_CLOUD_TOKEN', 'dev')
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
    worker.fetch(new Request(input, init), {
      SYNC_TOKEN: 'dev',
      DIRECTORY: {
        idFromName: () => 'directory',
        get: () => ({
          fetch: (url: string, request?: RequestInit) => directory.fetch(new Request(url, request)),
        }),
      },
    } as unknown as Parameters<typeof worker.fetch>[1]),
  )
  const ctx = {
    host: { userHome: home, home, projectRoot: root, notice: () => {} },
  } as unknown as ActionContext
  await expect(actions.relink({ from: 'not a key' }, ctx)).rejects.toThrow('Expected {from')
  await expect(actions.relink({ from: 'github.com/o/renamed' }, ctx)).rejects.toThrow('own key')
  expect(await actions.relink({ from: 'github.com/o/project' }, ctx)).toEqual({
    key: 'github.com/o/renamed',
    from: 'github.com/o/project',
  })
  expect(store.target('github.com/o/renamed')).toBe('github.com/o/project')
  expect(existsSync(join(home, 'cloud-lease.json'))).toBe(false)
})
