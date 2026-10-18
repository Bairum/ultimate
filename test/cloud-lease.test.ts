import { existsSync, readFileSync } from 'node:fs'
import { copyFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { ProjectDirectory } from '../cloud/worker.ts'
import worker from '../cloud/worker.ts'
import { DirectoryStore } from '../cloud/directory.ts'
import type { Transition } from '../cloud/protocol.ts'
import cloudExtension, { actions, joinOnStandby } from '../extensions/cloud/server.ts'
import type { SyncSocket } from '../extensions/cloud/server.ts'
import * as snapshot from '../extensions/cloud/snapshot.ts'
import { git } from '../extensions/workspaces/git.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import {
  author,
  checkout,
  cloud,
  idleRelease,
  inventory,
  KEY,
  machine,
  MINUTE,
  ownHistory,
  sleep,
  snapshotFetch,
  sql,
  standbyOn,
  states,
  toWorker,
  writer,
} from './cloud-lease-fixture.ts'
import { temp, until } from './helpers.ts'

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

const joining = { reason: 'Waiting for the cloud', joining: true, cloud: true }
/** A socket to a cloud that never answers. */
const unanswered = () =>
  Object.assign(new EventTarget(), { send: () => {}, close: () => {} }) as unknown as SyncSocket
it('joins on standby: a new project activates its first machine, a known one creates no database', async () => {
  const project = cloud()
  const { root } = await checkout()
  const deskHome = await temp('ultimate-lease-')
  expect(await joinOnStandby(deskHome, KEY)).toBe(true)
  const desk = await machine('desk', project, root, { home: deskHome })
  // Nobody knew the project: the cloud registers the joining machine as its writer, which opens a fresh database.
  await writer(desk)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(await desk.leaseFile()).toEqual({ key: KEY, epoch: 1 })
  expect(await desk.files()).toEqual(['state.sqlite'])
  // Its lease file names the project: it opens storage by itself from now on, the cloud reachable or not.
  expect(await joinOnStandby(deskHome, KEY)).toBe(false)
  expect(await joinOnStandby(deskHome, 'github.com/o/other')).toBe(true)

  const laptopHome = await temp('ultimate-lease-')
  expect(await joinOnStandby(laptopHome, KEY)).toBe(true)
  const laptop = await machine('laptop', project, root, { home: laptopHome })
  await standbyOn(laptop)
  expect(laptop.host.standby()).toEqual(joining)
  expect(laptop.serving()).toBe(false)
  expect(await readdir(laptopHome)).toEqual(['standby.json'])
})

it('keeps an existing database without a lease file on standby, untouched, while another machine writes', async () => {
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  const { home, before } = await ownHistory()
  expect(await joinOnStandby(home, KEY)).toBe(true)
  const laptop = await machine('laptop', project, root, { home })
  await standbyOn(laptop)
  expect(laptop.host.standby()).toMatchObject({ reason: 'Waiting for the cloud' })
  expect(laptop.serving()).toBe(false)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  // Its own history stays where it is, unopened: no stale copy, nothing synced.
  expect(await laptop.files()).toEqual(['state.sqlite'])
  await laptop.close()
  const reopened = await (
    await prepareHarness({ ultimateRoot: home, userHome: home, home, faux: true })
  ).open(false)
  expect(await inventory(reopened.harness)).toEqual(before)
  await reopened.close()
})

it('registers a new project with an existing database and writes that database in place', async () => {
  const project = cloud()
  const { root } = await checkout()
  const { home, before } = await ownHistory()
  expect(await joinOnStandby(home, KEY)).toBe(true)
  const desk = await machine('desk', project, root, { home })
  await writer(desk)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(await desk.files()).toEqual(['state.sqlite'])
  expect(await inventory(desk.harness())).toEqual(before)
})

it('waits on standby with no database while the cloud is unreachable, however long', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  try {
    const repo = await checkout()
    await git(repo.root, 'remote', 'set-url', 'origin', 'git@github.com:o/project.git')
    const home = await temp('ultimate-lease-offline-')
    vi.stubEnv('ULTIMATE_CLOUD_URL', 'ws://127.0.0.1:9')
    vi.stubEnv('ULTIMATE_CLOUD_TOKEN', 'dev')
    vi.stubEnv('ULTIMATE_CLOUD_MACHINE', 'laptop')
    const closers: (() => Promise<void>)[] = []
    const activate = vi.fn<ExtensionHost['activate']>()
    const host = {
      userHome: home,
      home,
      projectRoot: repo.root,
      notice: () => {},
      resource: <T>(_key: string, create: () => T) => create(),
      onOpen: () => {},
      onRelease: () => {},
      onClose: (close: () => Promise<void>) => closers.push(close),
      harness: () => {
        throw new Error('Harness is not open')
      },
      standby: () =>
        existsSync(join(home, 'standby.json'))
          ? (JSON.parse(readFileSync(join(home, 'standby.json'), 'utf8')) as JsonObject)
          : undefined,
      activate,
    } as unknown as ExtensionHost
    await cloudExtension(host, {
      dial: unanswered,
      builds: { connect: () => {}, stop: async () => {}, current: () => undefined },
    })
    expect(host.standby()).toEqual(joining)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(activate).not.toHaveBeenCalled()
    expect(await readdir(home)).toEqual(['standby.json'])
    for (const close of closers) await close()
  } finally {
    vi.useRealTimers()
  }
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

it('reports an oversized install failure by its last 500 characters, which the cloud keeps', async () => {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  const desk = await machine('desk', project, repo.root)
  await writer(desk)
  await idleRelease(desk)
  const lines = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(200, '.'))
  const laptop = await machine('laptop', project, repo.root, {
    autoClaim: false,
    pnpm: async () => {
      throw Object.assign(new Error('exit 1'), { stdout: lines.join('\n'), stderr: '' })
    },
  })
  await standbyOn(laptop)
  await repo.push({ 'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n' })
  expect(await laptop.lease.move()).toBe(false)
  const failed = project.replica.store.transition()!
  expect(failed.error).toHaveLength(500)
  expect(failed.error!.startsWith('…')).toBe(true)
  expect(failed.error!.endsWith(lines.at(-1)!)).toBe(true)
  expect(failed.steps.find((step) => step.name === 'install')).toMatchObject({
    state: 'failed',
    detail: failed.error,
  })
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
