import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { ProjectDirectory } from '../cloud/worker.ts'
import worker from '../cloud/worker.ts'
import { DirectoryStore } from '../cloud/directory.ts'
import type { Transition } from '../cloud/protocol.ts'
import cloudExtension, {
  actions,
  joinOnStandby,
  SECRETS_CHECK,
} from '../extensions/cloud/server.ts'
import type { SyncSocket } from '../extensions/cloud/server.ts'
import { modelLogin } from '../extensions/cloud/login.ts'
import * as snapshot from '../extensions/cloud/snapshot.ts'
import type { FeedbackService } from '../extensions/cloud/api.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { git } from '../lib/git.ts'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { context, prepareHarness } from '../server/harness.ts'
import {
  author,
  bucket,
  checkout,
  cloud,
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
import { eventHost, temp, until } from './helpers.ts'
import { BackupEvent, LeaseChanged, MoveEvent } from '../extensions/cloud/refs.ts'
import { classify } from '../extensions/cloud/lease.ts'
import type { Harness } from '@earendil-works/pi-durable'

/** The data of `cloud.backup` or `cloud.move` events in `harness`, oldest first. */
const cloudEvents = async (harness: () => Harness, event: typeof BackupEvent | typeof MoveEvent) =>
  (await eventHost(harness, 'test').eventLog.recent({ events: [event] }))
    .map((record) => record.data)
    .toReversed()
import { apply, plan } from '../scripts/reset.ts'

it('classifies a failure into a short reason, never echoing the raw error', () => {
  expect(classify('PUT /sync/snapshots: 503')).toBe('HTTP 503')
  expect(classify('Snapshot db-0 returned 404')).toBe('HTTP 404')
  expect(classify('Cancelled')).toBe('cancelled')
  expect(classify('git fetch failed: git@github.com: Permission denied (publickey).')).toBe(
    'git failed',
  )
  expect(classify('desk disconnected')).toBe('a machine disconnected')
  expect(classify('Bearer sk-secret-token rejected')).toBe('failed')
})

it('releases on a clean stop, and another machine prepares and takes over the same history', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  let desk = await machine('desk', project, root)
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

  desk = await desk.stopped()
  expect(desk.host.standby()).toMatchObject({
    reason: 'Released when Ultimate stopped',
    released: true,
  })
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
  // `state` names the key the cloud admitted and the move this machine ran itself, for @sync's fleet and watcher.
  expect(await laptop.lease.state()).toMatchObject({
    key: KEY,
    ran: { id: transition.id, target: 'laptop' },
  })
  // The desk keeps its database and hears who runs the project now.
  await until(() => desk.role()?.writer?.machine === 'laptop')
  expect(desk.serving()).toBe(false)
  expect(await desk.files()).toEqual(['state.sqlite'])
  // The snapshot carried the desk's release; the laptop's claim follows it. The desk served from the start, so it
  // never opened storage to acquire the lease.
  const leases = await eventHost(laptop.harness, 'test').eventLog.recent({ events: [LeaseChanged] })
  expect(leases.map((event) => event.data)).toEqual([
    { epoch: 2, writer: 'laptop', change: 'acquired' },
    { epoch: 1, writer: 'desk', change: 'releasing' },
  ])
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
      want: () => undefined,
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
    await cloudExtension(host, { dial: unanswered })
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
  let desk = await machine('desk', project, repo.root)
  await writer(desk)
  desk = await desk.stopped()
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

it('records who started each move: @sync through the bearer route or loopback, this page by default', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  let desk = await machine('desk', project, root)
  await writer(desk)
  desk = await desk.stopped()
  let laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  await until(() => !!laptop.role()?.free)
  // The Worker sends @sync's `/sync/move` to this replica path, which no browser request reaches.
  const moved = await project.replica.fetch(
    new Request('https://replica/sync/move', {
      method: 'POST',
      body: JSON.stringify({ machine: 'laptop' }),
    }),
  )
  expect(moved.status).toBe(202)
  const { id } = (await moved.json()) as { id: string }
  await writer(laptop)
  expect(project.replica.store.transition()).toMatchObject({ id, by: 'sync' })

  laptop = await laptop.stopped()
  await until(() => !!desk.role()?.free)
  const local = desk.lease.moveHere()
  await writer(desk)
  expect(project.replica.store.transition()).toMatchObject({ id: local.id, by: 'local' })

  desk = await desk.stopped()
  await until(() => !!laptop.role()?.free)
  const loopback = laptop.lease.moveHere({ by: 'sync' })
  await writer(laptop)
  expect(project.replica.store.transition()).toMatchObject({ id: loopback.id, by: 'sync' })
  expect(await laptop.transition()).toMatchObject({ id: loopback.id, by: 'sync' })
})

it('fails the checks without a model login, also when forced, leaving the lease free', async () => {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  let desk = await machine('desk', project, repo.root)
  await writer(desk)
  desk = await desk.stopped()
  const login = { provider: 'anthropic', ok: false }
  const laptop = await machine('laptop', project, repo.root, { autoClaim: false, login })
  await standbyOn(laptop)
  await until(() => !!laptop.role()?.free)
  expect((await laptop.lease.state()).login).toEqual(login)
  const error = 'No model login: anthropic is not configured here; log in with ⌘K → Log in'
  for (const force of [false, true]) {
    expect(await laptop.lease.move({ force })).toBe(false)
    expect(project.replica.store.transition()).toMatchObject({ error })
    expect(states(project.replica.store.transition())).toMatchObject({
      checks: 'failed',
      handover: 'pending',
    })
  }
  expect(project.replica.store.lease()).toMatchObject({ machine: null, epoch: 1 })
  expect(laptop.serving()).toBe(false)
  expect(laptop.snapshots.downloadSnapshot).not.toHaveBeenCalled()
})

/** The login of a host whose default provider is `provider`, with `configured` providers and models `available`. */
const loginOf = (provider: string | undefined, configured: string[], available: string[]) =>
  modelLogin({
    faux: undefined,
    // No health extension: every configured provider counts as working.
    want: () => undefined,
    settings: { getDefaultProvider: () => provider } as unknown as ExtensionHost['settings'],
    modelRuntime: {
      getProviderAuthStatus: (id: string) => ({ configured: configured.includes(id) }),
      getAvailable: async () => available.map((id) => ({ provider: id })),
    } as unknown as ExtensionHost['modelRuntime'],
  })

it('reads the model login of the default provider, or of any available model without one', async () => {
  // Another provider's login does not run the default model.
  expect(await loginOf('anthropic', ['openai'], ['openai'])).toEqual({
    provider: 'anthropic',
    ok: false,
  })
  expect(await loginOf('anthropic', ['anthropic'], [])).toEqual({ provider: 'anthropic', ok: true })
  expect(await loginOf(undefined, ['openai'], ['openai'])).toEqual({
    provider: 'openai',
    ok: true,
  })
  expect(await loginOf(undefined, [], [])).toEqual({ provider: 'a model provider', ok: false })
})

it('refuses a plain move when the writer has more secrets than its hello could name', async () => {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  let desk = await machine('desk', project, repo.root)
  // One past the limit: the hello names 64 and says the list is incomplete.
  for (let index = 0; index <= 64; index++) await writeSecret(desk.home, `SECRET_${index}`, 'x')
  await writer(desk)
  desk = await desk.stopped()
  const laptop = await machine('laptop', project, repo.root, { autoClaim: false })
  for (let index = 0; index < 64; index++) await writeSecret(laptop.home, `SECRET_${index}`, 'x')
  await standbyOn(laptop)
  expect((await laptop.lease.state()).missing).toEqual(['(more the writer could not list)'])
  expect(await laptop.lease.move()).toBe(false)
  expect(project.replica.store.transition()!.error).toMatch(/^Missing secrets: /)
  expect(project.replica.store.lease()).toMatchObject({ machine: null })
  expect(await laptop.lease.move({ force: true })).toBe(true)
})

it('keeps secret names current after hello: a standby and the writer add secrets, and missing updates on both ends', async () => {
  // Only the secrets check's interval is faked; sockets, roles and git run as usual.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    const project = cloud()
    const { root } = await checkout()
    const desk = await machine('desk', project, root)
    await writer(desk)
    const laptop = await machine('laptop', project, root, { autoClaim: false })
    await standbyOn(laptop)
    // The writer adds a secret after its hello: the standby hears it lacks it.
    await writeSecret(desk.home, 'GITHUB_TOKEN', 'x')
    await vi.advanceTimersByTimeAsync(SECRETS_CHECK)
    await until(async () => (await laptop.lease.state()).missing.length > 0)
    const cloudMissing = async () =>
      (
        (await (await project.api('/api/cloud')).json()) as {
          machines: { machine: string; missingSecrets: string[] }[]
        }
      ).machines.find((item) => item.machine === 'laptop')!.missingSecrets
    expect((await laptop.lease.state()).missing).toEqual(['GITHUB_TOKEN'])
    expect(await cloudMissing()).toEqual(['GITHUB_TOKEN'])
    const sockets = project.replica.admitted().length

    // The standby adds it: the cloud stops listing it, without either machine reconnecting.
    await writeSecret(laptop.home, 'GITHUB_TOKEN', 'x')
    await vi.advanceTimersByTimeAsync(SECRETS_CHECK)
    await until(async () => (await cloudMissing()).length === 0)
    expect((await laptop.lease.state()).missing).toEqual([])

    // The writer adds one: the standby hears it lacks it.
    await writeSecret(desk.home, 'OPENAI_API_KEY', 'x')
    await vi.advanceTimersByTimeAsync(SECRETS_CHECK)
    await until(async () => (await laptop.lease.state()).missing.length > 0)
    expect((await laptop.lease.state()).missing).toEqual(['OPENAI_API_KEY'])
    expect(await cloudMissing()).toEqual(['OPENAI_API_KEY'])
    expect(project.replica.admitted()).toHaveLength(sockets)
    expect(desk.notices).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

it('names the fast-forward and its commit count in the fetch step', async () => {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  let desk = await machine('desk', project, repo.root)
  await writer(desk)
  desk = await desk.stopped()
  const laptop = await machine('laptop', project, repo.root, { autoClaim: false })
  await standbyOn(laptop)
  const before = await git(repo.root, 'rev-parse', 'HEAD')
  await repo.push({ 'a.txt': 'a\n' })
  const tip = await repo.push({ 'b.txt': 'b\n' })
  expect(await laptop.lease.move()).toBe(true)
  const fetch = project.replica.store.transition()!.steps.find((step) => step.name === 'fetch')!
  expect(fetch).toEqual({
    name: 'fetch',
    state: 'done',
    commits: 2,
    detail: `main fast-forwarded 2 commits, ${before.slice(0, 7)}..${tip.slice(0, 7)}`,
  })
})

it('holds a move for worktrees with uncommitted changes, naming them, and releases once they are committed', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  // The main checkout has an untracked file, one worktree an edit, another none: two hold the move.
  const worktrees = await temp('ultimate-lease-worktrees-')
  const [edited, clean] = [join(worktrees, 'edited'), join(worktrees, 'clean')]
  await git(root, 'worktree', 'add', '-q', '-b', 'ultimate/edited', edited)
  await git(root, 'worktree', 'add', '-q', '-b', 'ultimate/clean', clean)
  await writeFile(join(edited, 'README.md'), 'edited\n')
  await writeFile(join(root, 'notes.txt'), 'scratch\n')
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  // Both machines share this checkout here; its untracked file does not stop the laptop's fast-forward.
  const moving = laptop.lease.move()
  const waiting = 'Move to laptop waits for 2 worktrees with uncommitted changes'
  await until(() => desk.notices.includes(waiting) && laptop.notices.includes(waiting))
  await until(() => project.replica.store.transition()?.left?.length === 2)
  expect(project.replica.store.transition()).toMatchObject({
    left: [root, edited],
    steps: expect.arrayContaining([
      {
        name: 'handover',
        state: 'running',
        detail: 'waiting for 2 worktrees with uncommitted changes',
      },
    ]),
  })
  expect(desk.serving()).toBe(true)
  expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
  // Committing them lets the next recheck release: here a task graph change wakes it.
  await rm(join(root, 'notes.txt'))
  await git(edited, 'commit', '-qam', 'edited')
  const task = await sleep(desk.harness(), false)
  await desk.harness().abortTask(task, context)
  expect(await moving).toBe(true)
  const transition = project.replica.store.transition()!
  expect(transition.left).toBeUndefined()
  expect(transition.steps.find((step) => step.name === 'handover')).toMatchObject({
    state: 'done',
    detail: 'desk released the project',
  })
})

for (const failing of ['worktree', 'status'] as const)
  it(`holds an unforced move when its worktree check fails (git ${failing}), and releases once it succeeds`, async () => {
    snapshotFetch()
    const project = cloud()
    const { root } = await checkout()
    let broken = true
    const desk = await machine('desk', project, root, {
      git: async (args) => {
        if (broken && args[0] === failing) throw new Error(`git ${failing} broke`)
      },
    })
    await writer(desk)
    const laptop = await machine('laptop', project, root, { autoClaim: false })
    await standbyOn(laptop)
    const moving = laptop.lease.move()
    await until(() =>
      desk.notices.some((notice) =>
        notice.startsWith('Move to laptop waits: could not check worktrees: '),
      ),
    )
    await until(
      () =>
        !!project.replica.store
          .transition()
          ?.steps.find((step) => step.name === 'handover')
          ?.detail?.includes(`could not check worktrees: `),
    )
    expect(
      project.replica.store.transition()!.steps.find((step) => step.name === 'handover')!.detail,
    ).toContain(`git ${failing} broke`)
    expect(desk.serving()).toBe(true)
    expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
    // The check works again: the next recheck, here a task graph change, releases.
    broken = false
    const task = await sleep(desk.harness(), false)
    await desk.harness().abortTask(task, context)
    expect(await moving).toBe(true)
    expect(project.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
  })

it('releases a forced move although its worktree check fails', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root, {
    git: async (args) => {
      if (args[0] === 'worktree') throw new Error('git worktree broke')
    },
  })
  await writer(desk)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  expect(await laptop.lease.move({ force: true })).toBe(true)
  expect(desk.notices).toContain(
    'Could not list worktrees with uncommitted changes: git worktree broke',
  )
})

it('holds again for a run that starts while it checks the worktrees', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const scanning = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const desk = await machine('desk', project, root, {
    git: async (args) => {
      if (args[0] !== 'worktree') return
      scanning.resolve()
      await resume.promise
    },
  })
  await writer(desk)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  const moving = laptop.lease.move()
  await scanning.promise
  const task = await sleep(desk.harness(), false)
  resume.resolve()
  await until(() => desk.notices.includes('Move to laptop waits for 1 running task'))
  expect(desk.serving()).toBe(true)
  expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
  await desk.harness().abortTask(task, context)
  expect(await moving).toBe(true)
})

it('scans again when a run came and went during the scan, holding for the worktree it dirtied', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const worktrees = await temp('ultimate-lease-rescan-')
  const later = join(worktrees, 'later')
  await git(root, 'worktree', 'add', '-q', '-b', 'ultimate/later', later)
  // The first scan pauses on the second worktree's status, after the main checkout was found clean.
  const paused = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let statuses = 0
  const desk = await machine('desk', project, root, {
    git: async (args) => {
      if (args[0] !== 'status' || ++statuses !== 2) return
      paused.resolve()
      await resume.promise
    },
  })
  await writer(desk)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  const moving = laptop.lease.move()
  await paused.promise
  // A run starts, edits the already-scanned main checkout and ends before the scan returns.
  const task = await sleep(desk.harness(), false)
  await writeFile(join(root, 'notes.txt'), 'written by a short run\n')
  await desk.harness().abortTask(task, context)
  resume.resolve()
  await until(() =>
    desk.notices.includes('Move to laptop waits for 1 worktree with uncommitted changes'),
  )
  await until(() => project.replica.store.transition()?.left?.length === 1)
  expect(project.replica.store.transition()!.left).toEqual([root])
  expect(desk.serving()).toBe(true)
  expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
  laptop.lease.cancel()
  expect(await moving).toBe(false)
})

/**
 * Runs due fake timers while a test polls with `until`. It advances 1 ms, not 0: a zero-delay timer created while the
 * fake clock is mid-tick (a socket message arriving between its timers) is due 1 ms later, and a 0 ms advance never
 * reaches it, so the move would stall at its handover.
 */
const tick = () => vi.advanceTimersByTimeAsync(1)

it('holds a move for the runs it drains past the old ten-minute cap, naming their conversations', async () => {
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  await sleep(desk.harness(), false)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  try {
    void laptop.lease.move()
    await until(() => desk.notices.includes('Move to laptop waits for 1 running task'), 30000, tick)
    await until(() => !!project.replica.store.transition()?.waiting, 30000, tick)
    expect(project.replica.store.transition()).toMatchObject({
      waiting: [`#${ROOT_CONVERSATION_ID}`],
      steps: expect.arrayContaining([
        { name: 'handover', state: 'running', detail: 'finishing 1 run' },
      ]),
    })
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(desk.serving()).toBe(true)
    expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
    expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
    expect((await laptop.transition())?.error).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
  // Cancelling, on real timers again, still ends the hold.
  laptop.lease.cancel()
  await until(() =>
    desk.notices.includes('The move to laptop stopped; this machine keeps the project'),
  )
})

it('releases a forced move at once despite running tasks and uncommitted worktrees, naming those left behind', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  const worktrees = await temp('ultimate-lease-forced-')
  const edited = join(worktrees, 'edited')
  await git(root, 'worktree', 'add', '-q', '-b', 'ultimate/forced', edited)
  await writeFile(join(edited, 'README.md'), 'edited\n')
  await sleep(desk.harness(), false)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  expect(await laptop.lease.move({ force: true })).toBe(true)
  expect(desk.notices.some((notice) => notice.startsWith('Move to laptop waits'))).toBe(false)
  const transition = project.replica.store.transition()!
  expect(transition.left).toEqual([edited])
  expect(transition.steps.find((step) => step.name === 'handover')).toMatchObject({
    state: 'done',
    detail: '1 worktree with uncommitted changes stays on desk',
  })
  expect(project.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
})

it('bounds a successful step detail too, so a long branch name never stalls the transition', async () => {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  let desk = await machine('desk', project, repo.root)
  await writer(desk)
  desk = await desk.stopped()
  const laptop = await machine('laptop', project, repo.root, { autoClaim: false })
  await standbyOn(laptop)
  // Long as a whole; each path segment stays within file-name limits.
  const branch = Array.from({ length: 6 }, () => 'x'.repeat(100)).join('/')
  await git(repo.root, 'checkout', '-q', '-b', branch)
  await git(repo.root, 'push', '-q', 'origin', branch)
  await git(repo.root, 'remote', 'set-head', 'origin', branch)
  expect(await laptop.lease.move()).toBe(true)
  const fetch = project.replica.store.transition()!.steps.find((step) => step.name === 'fetch')!
  expect(fetch.state).toBe('done')
  expect(fetch.detail!.length).toBeLessThanOrEqual(500)
  expect(fetch.detail!.endsWith('already up to date')).toBe(true)
})

it('reports an oversized install failure by its last 500 characters, which the cloud keeps', async () => {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  let desk = await machine('desk', project, repo.root)
  await writer(desk)
  desk = await desk.stopped()
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
  let desk = await machine('desk', project, repo.root)
  await writer(desk)
  desk = await desk.stopped()
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

it('moves from @sync: the online writer drains, and every step reaches its socket', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  const task = await sleep(desk.harness(), false)
  const laptop = await machine('laptop', project, root)
  await standbyOn(laptop)
  const response = await project.api('/sync/move', { machine: 'laptop' })
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
  expect(project.replica.store.transition()).toMatchObject({ id, by: 'sync' })
  // The desk's `started` came with the snapshot; the laptop records `done` once it opened storage.
  const move = { project: KEY, id, from: 'desk', to: 'laptop' }
  expect(await cloudEvents(laptop.harness, MoveEvent)).toEqual([
    { phase: 'started', ...move },
    { phase: 'done', ...move, ms: expect.any(Number) },
  ])
  expect(desk.host.standby()).toMatchObject({ reason: 'Moved to laptop', explained: true })
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
  // The writer that kept the project records the move's start and its end at the target's failed step.
  const move = { project: KEY, id, from: 'desk', to: 'laptop' }
  await until(async () => (await cloudEvents(desk.harness, MoveEvent)).length === 2)
  expect(await cloudEvents(desk.harness, MoveEvent)).toEqual([
    { phase: 'started', ...move },
    { phase: 'failed', ...move, step: 'handover', reason: 'cancelled' },
  ])
})

it('keeps the project when the move is cancelled while it scans for uncommitted work', async () => {
  const project = cloud()
  const { root } = await checkout()
  const scanning = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const desk = await machine('desk', project, root, {
    git: async (args) => {
      if (args[0] !== 'status') return
      scanning.resolve()
      await resume.promise
    },
  })
  await writer(desk)
  const laptop = await machine('laptop', project, root)
  await standbyOn(laptop)
  const { id } = laptop.lease.moveHere()
  await scanning.promise
  expect((await project.api('/api/cloud/cancel', {})).status).toBe(202)
  await until(async () => (await laptop.transition())?.error === 'Cancelled')
  await until(() => desk.lease.sync()?.state().transition?.error === 'Cancelled')
  resume.resolve()
  await until(() =>
    desk.notices.includes('The move to laptop stopped; this machine keeps the project'),
  )
  expect(await laptop.transition()).toMatchObject({ id, error: 'Cancelled' })
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(desk.serving()).toBe(true)
  expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
  expect((await cloudEvents(desk.harness, MoveEvent)).at(-1)).toEqual({
    phase: 'failed',
    project: KEY,
    id,
    from: 'desk',
    to: 'laptop',
    step: 'handover',
    reason: 'cancelled',
  })
})

it('keeps the lease and keeps serving while busy, also when its connection drops', async () => {
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  await sleep(desk.harness(), false)
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
  let desk = await machine('desk', project, root)
  await writer(desk)
  desk = await desk.stopped()
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
  let desk = await machine('desk', project, root)
  await writer(desk)
  await desk
    .harness()
    .commit(
      (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: 'lease-test.entry', data: {} }),
      context,
    )
  const before = await inventory(desk.harness())
  desk = await desk.stopped()
  await desk.close()
  const restarted = await machine('desk', project, root, { home: desk.home })
  await writer(restarted)
  expect(restarted.snapshots.downloadSnapshot).not.toHaveBeenCalled()
  expect(states(await restarted.transition())).toMatchObject({ download: 'skipped', claim: 'done' })
  // Nobody clicked: the starting machine took the free lease by itself.
  expect(project.replica.store.transition()?.by).toBe('auto')
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
  let desk = await machine('desk', project, root)
  await writer(desk)
  desk = await desk.stopped()
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

it('backs up while serving: a manifest, the database and the bundle go up, and the lease stays as it was', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  await git(root, 'branch', 'ultimate/feature')
  const desk = await machine('desk', project, root)
  await writer(desk)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  await desk
    .harness()
    .commit(
      (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: 'lease-test.entry', data: {} }),
      context,
    )
  const leaseBefore = readFileSync(join(desk.home, 'cloud-lease.json'), 'utf8')
  const replicaBefore = structuredClone(project.replica.store.lease())
  expect((await desk.lease.state()).lastBackup).toBeUndefined()

  const done = await desk.lease.backup()
  expect(done).toEqual({
    id: expect.any(String),
    at: expect.any(Number),
    bytes: expect.any(Number),
  })
  // Every part of the snapshot is in R2 under its id: the manifest, the database and the branch bundle.
  const parts = bucket
    .keys()
    .filter((name) => name.includes(`/${done.id}/`))
    .map((name) => name.split('/').at(-1)!)
    .toSorted((a, b) => a.localeCompare(b))
  expect(parts).toEqual(['bundle-0', 'db-0', 'manifest'])
  // It restores like a move's snapshot, with the entry written before it.
  const restored = await snapshot.downloadSnapshot({
    url: 'ws://127.0.0.1:8787',
    token: 'dev',
    secret: 'snapshot secret',
    key: KEY,
    id: done.id,
    dir: await temp('ultimate-backup-restore-'),
    repo: root,
  })
  expect(restored.manifest).toMatchObject({ machine: 'desk', epoch: 1, bundle: { chunks: 1 } })
  expect(restored.manifest.database.bytes + restored.manifest.bundle!.bytes).toBe(done.bytes)

  // The lease, its holder, its epoch and the lease file are untouched; the writer kept serving throughout.
  expect(readFileSync(join(desk.home, 'cloud-lease.json'), 'utf8')).toBe(leaseBefore)
  expect(project.replica.store.lease()).toEqual(replicaBefore)
  expect(project.replica.store.transition()).toBeUndefined()
  expect(desk.serving()).toBe(true)
  expect(desk.role()).toMatchObject({ role: 'writer', epoch: 1 })
  expect(laptop.role()).toMatchObject({ role: 'standby', free: false })
  // The cloud records the backup for the fleet, apart from the lease.
  await until(() => project.replica.store.lastBackupAt() === done.at)
  expect(await desk.lease.state()).toMatchObject({ lastBackup: done })
  expect((await desk.lease.state()).backup).toBeUndefined()
})

it('prunes backups like any snapshot: the Worker keeps the three newest complete ones', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root, { key: 'github.com/o/backups' })
  await writer(desk)
  const ids: string[] = []
  for (let count = 0; count < 5; count++) ids.push((await desk.lease.backup()).id)
  const kept = new Set(
    bucket
      .keys()
      .filter((name) => name.endsWith('/manifest') && ids.some((id) => name.includes(`/${id}/`)))
      .map((name) => name.split('/').at(-2)),
  )
  // Ordering by upload time, ties included, is `cloud-snapshot.test.ts`'s retention test; here: three, the latest kept.
  expect(kept.size).toBe(3)
  expect(kept.has(ids.at(-1))).toBe(true)
  // Nothing but the kept snapshots' parts is left.
  expect(
    bucket.keys().filter((name) => ids.some((id) => name.includes(`/${id}/`) && !kept.has(id))),
  ).toEqual([])
})

/** A `cloud.feedback` point that records what machine `name`'s lease reports. */
const heard = (name: string) => {
  const events: { machine: string; kind: string; value: unknown }[] = []
  const feedback: FeedbackService = {
    backup: async (report) => void events.push({ machine: name, kind: 'backup', value: report }),
    moved: async (input) => void events.push({ machine: name, kind: 'moved', value: input }),
  }
  return { events, feedback }
}

it('reports each backup and a move that ended here once, to the feedback point of the machine it happened on', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const deskHeard = heard('desk')
  let failing = false
  const flaky = {
    ...snapshot,
    uploadSnapshot: vi.fn<typeof snapshot.uploadSnapshot>(async (o) => {
      if (failing) throw new Error('PUT /sync/snapshots: 503')
      return snapshot.uploadSnapshot(o)
    }),
  }
  const desk = await machine('desk', project, root, {
    snapshots: flaky,
    feedback: deskHeard.feedback,
  })
  await writer(desk)
  const done = await desk.lease.backup()
  failing = true
  await expect(desk.lease.backup()).rejects.toThrow('503')
  failing = false
  expect(deskHeard.events).toEqual([
    {
      machine: 'desk',
      kind: 'backup',
      value: { ok: true, ...done, ms: expect.any(Number) },
    },
    {
      machine: 'desk',
      kind: 'backup',
      value: { ok: false, at: expect.any(Number), error: 'PUT /sync/snapshots: 503' },
    },
  ])
  // Each backup is `started`, then `done` with its size or `failed` with a classified reason.
  expect(await cloudEvents(desk.harness, BackupEvent)).toEqual([
    { phase: 'started', project: KEY },
    { phase: 'done', project: KEY, bytes: done.bytes, ms: expect.any(Number) },
    { phase: 'started', project: KEY },
    { phase: 'failed', project: KEY, ms: expect.any(Number), reason: 'HTTP 503' },
  ])

  await sleep(desk.harness(), true)
  const laptopHeard = heard('laptop')
  const laptop = await machine('laptop', project, root, {
    autoClaim: false,
    feedback: laptopHeard.feedback,
  })
  await standbyOn(laptop)
  expect(await laptop.lease.move()).toBe(true)
  // The target hears the move once, with storage open; the source machine hears nothing of it.
  expect(laptopHeard.events).toEqual([
    {
      machine: 'laptop',
      kind: 'moved',
      value: {
        key: KEY,
        machine: 'laptop',
        transition: expect.objectContaining({ target: 'laptop', from: 'desk', by: 'local' }),
      },
    },
  ])
  expect(laptop.serving()).toBe(true)
  expect(deskHeard.events).toHaveLength(2)
})

/** Desk as the writer with a backup held open mid-upload, and laptop on standby; `finish` lets the upload end. */
async function heldBackup() {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  let backups = 0
  const deferred = {
    ...snapshot,
    uploadSnapshot: vi.fn<typeof snapshot.uploadSnapshot>(async (o) => {
      // The first upload is the backup, held open; any later one is a release's.
      if (backups++ === 0) {
        started.resolve()
        await gate.promise
      }
      return snapshot.uploadSnapshot(o)
    }),
  }
  const desk = await machine('desk', project, root, { snapshots: deferred })
  await writer(desk)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  const backup = desk.lease.backup()
  await started.promise
  return { project, desk, laptop, deferred, backup, finish: () => gate.resolve() }
}

it('keeps the project when a move is cancelled while it waits for a backup, and releases nothing', async () => {
  const { project, desk, laptop, deferred, backup, finish } = await heldBackup()
  const moving = laptop.lease.move()
  // The writer found nothing to hold for and waits for the backup's upload, its watchers still active.
  await until(() => desk.notices.includes('Move to laptop waits for a backup to finish'))
  laptop.lease.cancel()
  expect(await moving).toBe(false)
  await until(() =>
    desk.notices.includes('The move to laptop stopped; this machine keeps the project'),
  )
  finish()
  await backup
  await desk.lease.settled()
  // Only the backup uploaded: no release followed it.
  expect(deferred.uploadSnapshot).toHaveBeenCalledOnce()
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(desk.serving()).toBe(true)
})

it('holds a move again for a run that starts while it waits for a backup', async () => {
  const { project, desk, laptop, deferred, backup, finish } = await heldBackup()
  const moving = laptop.lease.move()
  await until(() => desk.notices.includes('Move to laptop waits for a backup to finish'))
  const task = await sleep(desk.harness(), false)
  await until(() => desk.notices.includes('Move to laptop waits for 1 running task'))
  finish()
  await backup
  // The backup is done, but the run holds the release.
  await until(() => !!project.replica.store.transition()?.waiting)
  expect(deferred.uploadSnapshot).toHaveBeenCalledOnce()
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(desk.serving()).toBe(true)
  // Once it ends, the move releases and the laptop takes the project.
  await desk.harness().abortTask(task, context)
  expect(await moving).toBe(true)
  expect(deferred.uploadSnapshot).toHaveBeenCalledTimes(2)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
})

it('keeps the lease on stop while a backup still uploads', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const deferred = {
    ...snapshot,
    uploadSnapshot: vi.fn<typeof snapshot.uploadSnapshot>(async (o) => {
      started.resolve()
      await gate.promise
      return snapshot.uploadSnapshot(o)
    }),
  }
  const desk = await machine('desk', project, root, { snapshots: deferred })
  await writer(desk)
  const backingUp = desk.lease.backup()
  await started.promise
  await desk.lease.stopRelease()
  expect(desk.notices).toContain('Kept the lease on stop: a backup was still uploading.')
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(desk.serving()).toBe(true)
  gate.resolve()
  await backingUp
  expect(deferred.uploadSnapshot).toHaveBeenCalledOnce()
})

it('refuses a second backup while one runs, during a release, and on a standby', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const slow = {
    ...snapshot,
    uploadSnapshot: vi.fn<typeof snapshot.uploadSnapshot>(async (o) => {
      o.progress?.(5, 10)
      started.resolve()
      await gate.promise
      return snapshot.uploadSnapshot(o)
    }),
  }
  let desk = await machine('desk', project, root, { snapshots: slow })
  await writer(desk)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)

  const first = desk.lease.backup()
  await started.promise
  expect((await desk.lease.state()).backup).toEqual({ done: 5, total: 10 })
  await expect(desk.lease.backup()).rejects.toThrow('a backup is already running')
  gate.resolve()
  await first
  expect(slow.uploadSnapshot).toHaveBeenCalledOnce()

  await expect(laptop.lease.backup()).rejects.toThrow(
    'This machine does not run the project; back it up on its writer',
  )
  // Not a writer either once it released: the snapshot it uploads is the release's, not a backup.
  desk = await desk.stopped()
  await expect(desk.lease.backup()).rejects.toThrow('does not run the project')
  expect(slow.uploadSnapshot).toHaveBeenCalledTimes(2)
})

it('starts no backup or move while the host is paused', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  let paused = true
  const desk = await machine('desk', project, root, { paused: () => paused })
  await writer(desk)
  const laptop = await machine('laptop', project, root, { autoClaim: false, paused: () => true })
  await standbyOn(laptop)

  const refusal = 'Ultimate is paused; press Play first'
  await expect(desk.lease.backup()).rejects.toThrow(refusal)
  expect(() => laptop.lease.moveHere()).toThrow(refusal)
  // A move @sync starts goes through the same preparation, which refuses too.
  expect(await laptop.lease.move({ by: 'sync' })).toBe(false)
  expect(laptop.notices).toContain(`Move here refused: ${refusal}`)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk' })

  paused = false
  expect(await desk.lease.backup()).toMatchObject({ id: expect.any(String) })
})

it('refuses a backup while a move holds the writer, and keeps the last backup across restarts', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  const desk = await machine('desk', project, root)
  await writer(desk)
  const done = await desk.lease.backup()
  expect(JSON.parse(readFileSync(join(desk.home, 'cloud-backup.json'), 'utf8'))).toEqual({
    key: KEY,
    ...done,
  })
  await desk.close()

  const restarted = await machine('desk', project, root, { home: desk.home })
  await writer(restarted)
  await until(async () => (await restarted.lease.state()).lastBackup?.id === done.id)
  // A restarted writer names its last backup in hello, so the fleet keeps showing it.
  expect(project.replica.store.lastBackupAt()).toBe(done.at)

  // A move drains a running task on the writer; a backup waits for nothing and is refused meanwhile.
  await sleep(restarted.harness(), false)
  const laptop = await machine('laptop', project, root, { autoClaim: false })
  await standbyOn(laptop)
  void laptop.lease.move()
  await until(async () => (await laptop.transition())?.step === 'handover')
  await until(() => restarted.notices.some((notice) => notice.includes('waits for 1 running')))
  await expect(restarted.lease.backup()).rejects.toThrow('A move or release is in flight')
  laptop.lease.cancel()
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

it('claims a reset home as its released snapshot: no download, the fresh database opens', async () => {
  snapshotFetch()
  const project = cloud()
  const { root } = await checkout()
  let desk = await machine('desk', project, root)
  await writer(desk)
  const fresh = await inventory(desk.harness())
  await desk
    .harness()
    .commit(
      (tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: 'lease-test.entry', data: {} }),
      context,
    )
  desk = await desk.stopped()
  await desk.close()
  const reset = await plan(desk.home, await temp('ultimate-reset-backups-'))
  expect(reset).toMatchObject({ cloud: true })
  await apply(reset)
  expect(readdirSync(reset.backup)).toContain('state.sqlite')
  const restarted = await machine('desk', project, root, { home: desk.home })
  await writer(restarted)
  expect(restarted.snapshots.downloadSnapshot).not.toHaveBeenCalled()
  expect(states(await restarted.transition())).toMatchObject({ download: 'skipped', claim: 'done' })
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 2 })
  expect((await inventory(restarted.harness())).entries).toBe(fresh.entries)
})
