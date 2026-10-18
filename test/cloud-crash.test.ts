// Kill points of a move: a machine freezes mid-step, crashes there, and a fresh process on the same home recovers.
// After every restart exactly one machine writes, or the lease is free with its snapshot; nothing is stuck; the
// writer's database holds the released history; and no database is deleted.
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  checkout,
  cloud,
  idleRelease,
  inventory,
  KEY,
  machine,
  MINUTE,
  seed,
  sleep,
  snapshotFetch,
  standbyOn,
  writer,
} from './cloud-lease-fixture.ts'
import type { KillPoint, Machine } from './cloud-lease-fixture.ts'
import { temp, until } from './helpers.ts'

/** The desk wrote some history and released it idle: the lease is free at epoch 1 with the desk's snapshot. */
async function released() {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  const desk = await machine('desk', project, repo.root)
  await writer(desk)
  await seed(desk.harness())
  const before = await inventory(desk.harness())
  await idleRelease(desk)
  return { project, repo, desk, before }
}
/** `m` writes the project with the released history, alone, with no claim or download left behind. */
async function recovered(
  project: ReturnType<typeof cloud>,
  m: Machine,
  before: Awaited<ReturnType<typeof inventory>>,
) {
  await writer(m)
  expect(project.settled()).toBe(true)
  expect(project.replica.store.lease()?.machine).toBe(m.role()?.writer?.machine)
  expect(await inventory(m.harness())).toEqual(before)
  expect(existsSync(join(m.home, 'cloud-claim.json'))).toBe(false)
  expect(existsSync(join(m.home, 'standby.json'))).toBe(false)
  expect((await m.files()).filter((file) => /snapshot-/.test(file))).toEqual([])
  expect(await m.leaseFile()).toMatchObject({
    key: KEY,
    epoch: project.replica.store.lease()!.epoch,
  })
}
const intent = (m: Machine) => existsSync(join(m.home, 'cloud-claim.json'))

const install = [['pnpm', 'install', '--frozen-lockfile']]
it.each<[string, KillPoint, string[][], boolean]>([
  // The owed install runs again on restart.
  ['after fetch, while installing', 'pnpm', install, false],
  ['after install, in the checks', 'checks', [], false],
  // A download left without a claim is removed on start and fetched afresh.
  ['after the download, before the claim', 'download', [], true],
])('recovers a target that crashed %s', async (_point, kill, installs, downloaded) => {
  const { project, repo, before } = await released()
  if (installs.length) await repo.push({ 'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n' })
  // A starting machine claims the free lease by itself, and freezes on the way.
  const laptop = await machine('laptop', project, repo.root, { kill })
  await laptop.reached
  await laptop.crash()
  // Its transition does not stay running in the cloud.
  expect(project.replica.store.transition()).toMatchObject({
    target: 'laptop',
    error: 'laptop disconnected',
    cancellable: false,
  })
  expect(project.settled()).toBe(true)
  expect((await laptop.files()).some((file) => file.startsWith('snapshot-'))).toBe(downloaded)
  const restarted = await machine('laptop', project, repo.root, { home: laptop.home })
  await recovered(project, restarted, before)
  expect(restarted.installs).toEqual(installs)
  expect(restarted.snapshots.downloadSnapshot).toHaveBeenCalledOnce()
})

it('drops a claim that never reached the cloud, then claims again', async () => {
  const { project, repo, before } = await released()
  const dropped = project.hold('laptop', 'claim', 'drop')
  const laptop = await machine('laptop', project, repo.root)
  await dropped
  expect(intent(laptop)).toBe(true)
  await laptop.crash()
  expect(project.replica.store.lease()).toMatchObject({ machine: null, epoch: 1 })
  const restarted = await machine('laptop', project, repo.root, { home: laptop.home })
  await recovered(project, restarted, before)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
})

it('finishes a claim the cloud granted when its reply was lost', async () => {
  const { project, repo, before } = await released()
  const granted = project.hold('laptop', 'claim', 'mute')
  const laptop = await machine('laptop', project, repo.root)
  await granted
  expect(project.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
  await laptop.crash()
  // The claim won: its transition is not failed for the disconnect.
  expect(project.replica.store.transition()?.error).toBeUndefined()
  const restarted = await machine('laptop', project, repo.root, { home: laptop.home })
  await recovered(project, restarted, before)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'laptop', epoch: 2 })
  // The verified download from before the crash was installed.
  expect(restarted.snapshots.downloadSnapshot).not.toHaveBeenCalled()
})

it('finishes a claim that crashed after the reply, before storage opened', async () => {
  const { project, repo, before } = await released()
  const laptop = await machine('laptop', project, repo.root, { kill: 'activate' })
  await laptop.reached
  await laptop.crash()
  expect(await laptop.leaseFile()).toEqual({ key: KEY, epoch: 2 })
  expect(intent(laptop)).toBe(true)
  const restarted = await machine('laptop', project, repo.root, { home: laptop.home })
  await recovered(project, restarted, before)
  expect(restarted.snapshots.downloadSnapshot).not.toHaveBeenCalled()
})

it('keeps writing after a crash right after the claim opened storage', async () => {
  const { project, repo, before } = await released()
  const laptop = await machine('laptop', project, repo.root)
  await writer(laptop)
  await laptop.crash()
  const restarted = await machine('laptop', project, repo.root, { home: laptop.home })
  expect(restarted.serving()).toBe(true)
  await recovered(project, restarted, before)
})

it('lets the draining writer keep the project when its target crashes during the handover', async () => {
  const project = cloud()
  const repo = await checkout()
  const desk = await machine('desk', project, repo.root)
  await writer(desk)
  await sleep(desk.harness(), false)
  const laptop = await machine('laptop', project, repo.root)
  await standbyOn(laptop)
  laptop.lease.moveHere()
  await until(() => desk.notices.includes('Move to laptop waits for 1 running task'))
  await laptop.crash()
  await until(() =>
    desk.notices.includes('The move to laptop stopped; this machine keeps the project'),
  )
  expect(project.replica.store.transition()).toMatchObject({
    error: 'laptop disconnected',
    steps: expect.arrayContaining([
      { name: 'handover', state: 'failed', detail: 'laptop disconnected' },
    ]),
  })
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(desk.serving()).toBe(true)
  expect(desk.snapshots.uploadSnapshot).not.toHaveBeenCalled()
  const restarted = await machine('laptop', project, repo.root, { home: laptop.home })
  await standbyOn(restarted)
  expect(project.settled()).toBe(true)
  expect(await restarted.lease.state()).toMatchObject({ blocked: undefined })
})

/** The desk, holding the lease with some history, releases idle and crashes at `point`. */
async function holder(point: 'upload' | 'release dropped' | 'release muted' | 'released') {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  const desk = await machine(
    'desk',
    project,
    repo.root,
    point === 'upload' ? { kill: 'upload' as const } : {},
  )
  await writer(desk)
  await seed(desk.harness())
  const before = await inventory(desk.harness())
  const held =
    point === 'release dropped'
      ? project.hold('desk', 'release', 'drop')
      : point === 'release muted'
        ? project.hold('desk', 'release', 'mute')
        : undefined
  const start = Date.now()
  expect(await desk.lease.checkIdle(start)).toBe(false)
  const releasing = desk.lease.checkIdle(start + 10 * MINUTE)
  await (point === 'upload' ? desk.reached : (held ?? releasing))
  await desk.crash()
  return { project, repo, desk, before }
}

it.each(['upload', 'release dropped'] as const)(
  'resumes a holder that crashed before its release was sent (%s) as the writer of its own history',
  async (point) => {
    const { project, repo, desk, before } = await holder(point)
    expect(existsSync(join(desk.home, 'standby.json'))).toBe(true)
    const restarted = await machine('desk', project, repo.root, { home: desk.home })
    await recovered(project, restarted, before)
    expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
    expect(restarted.snapshots.downloadSnapshot).not.toHaveBeenCalled()
  },
)

it.each(['release muted', 'released'] as const)(
  'leaves the lease free with the snapshot when the holder crashed after its release (%s)',
  async (point) => {
    const { project, repo, desk, before } = await holder(point)
    const restarted = await machine('desk', project, repo.root, {
      home: desk.home,
      autoClaim: false,
    })
    await standbyOn(restarted)
    expect(project.settled()).toBe(true)
    expect(project.replica.store.lease()).toMatchObject({ machine: null, epoch: 1 })
    expect(restarted.host.standby()).toMatchObject({ reason: 'Released · resume here' })
    // Its database is that snapshot: resuming here needs no download.
    expect(await restarted.lease.move()).toBe(true)
    await recovered(project, restarted, before)
    expect(restarted.snapshots.downloadSnapshot).not.toHaveBeenCalled()
  },
)

it('ends a handover whose holder crashed mid-upload once it restarts, resuming its own history', async () => {
  snapshotFetch()
  const project = cloud()
  const repo = await checkout()
  const desk = await machine('desk', project, repo.root, { kill: 'upload' })
  await writer(desk)
  await seed(desk.harness())
  const before = await inventory(desk.harness())
  const laptop = await machine('laptop', project, repo.root)
  await standbyOn(laptop)
  const moving = laptop.lease.move()
  await desk.reached
  await desk.crash()
  // The holder still holds the lease; once it is back without the release, the move ends.
  const restarted = await machine('desk', project, repo.root, { home: desk.home })
  expect(await moving).toBe(false)
  expect(await laptop.transition()).toMatchObject({ error: 'desk disconnected' })
  expect(laptop.snapshots.downloadSnapshot).not.toHaveBeenCalled()
  await recovered(project, restarted, before)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  await standbyOn(laptop)
})

it('opens a project this joining machine just registered, with nothing to install', async () => {
  const project = cloud()
  const repo = await checkout()
  const home = await temp('ultimate-lease-join-')
  await writeFile(
    join(home, 'standby.json'),
    JSON.stringify({ reason: `Joining ${KEY}…`, cloud: true }),
  )
  const desk = await machine('desk', project, repo.root, { home })
  await writer(desk)
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 1 })
  expect(await desk.leaseFile()).toEqual({ key: KEY, epoch: 1 })
  expect(desk.snapshots.downloadSnapshot).not.toHaveBeenCalled()
})

it('installs the last snapshot before writing when its standby database is not the writer state', async () => {
  const { project, repo, desk, before } = await released()
  // The desk takes its own snapshot back (epoch 2), then loses its lease file and its database is replaced.
  expect(await desk.lease.move()).toBe(true)
  await writer(desk)
  await desk.crash()
  await rm(join(desk.home, 'cloud-lease.json'))
  for (const file of await readdir(desk.home))
    if (file.startsWith('state.sqlite')) await rm(join(desk.home, file))
  await writeFile(join(desk.home, 'standby.json'), JSON.stringify({ reason: 'reinstalled' }))
  const restarted = await machine('desk', project, repo.root, { home: desk.home })
  await recovered(project, restarted, before)
  expect(restarted.snapshots.downloadSnapshot).toHaveBeenCalledOnce()
  expect(project.replica.store.lease()).toMatchObject({ machine: 'desk', epoch: 2 })
})

it('removes snapshot temp files and downloads no claim owns on start', async () => {
  const { project, repo } = await released()
  const home = await temp('ultimate-lease-tidy-')
  await writeFile(join(home, 'standby.json'), JSON.stringify({ reason: 'test' }))
  await writeFile(join(home, 'snapshot-orphan.sqlite'), 'orphan')
  await writeFile(join(home, 'snapshot-orphan.sqlite.part'), 'orphan')
  await mkdir(join(home, '.snapshot-abc'))
  const laptop = await machine('laptop', project, repo.root, { home, autoClaim: false })
  await standbyOn(laptop)
  await until(async () => (await laptop.files()).length === 0)
  expect(laptop.notices).toEqual([])
})
