// Two machines hand one project over through a local Worker (`cloud-helpers.ts`): a new project registers, a second
// machine joins on standby, the project moves to it and back, and a move is cancelled during its download.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CloudInfo } from '../../cloud/protocol.ts'
import { post, temp, until } from '../helpers.ts'
import {
  cloudSkip,
  counts,
  git,
  host,
  ids,
  projectApi,
  repository,
  secretValue,
  serving,
  slowProxy,
  stopAll,
  worker,
} from './cloud-helpers.ts'
import type { Host } from './cloud-helpers.ts'

const KEY = 'github.com/hazat/e2e-handoff'
const token = randomBytes(16).toString('hex')
const snapshotKey = randomBytes(32).toString('base64url')
let root: string
let repo: Awaited<ReturnType<typeof repository>>
let cloud: Awaited<ReturnType<typeof worker>>
let proxy: Awaited<ReturnType<typeof slowProxy>>
let project: ReturnType<typeof projectApi>
let a: Host
let b: Host

const files = async (home: string) => (await readdir(home)).toSorted()
/** Follow the transition `id` (or any) until it ends, collecting each step seen running. */
async function follow(id?: string) {
  const running = new Set<string>()
  let last: CloudInfo['transition'] = null
  await until(async () => {
    const { transition } = await project.info()
    if (!transition || (id && transition.id !== id)) return false
    last = transition
    for (const step of transition.steps) if (step.state === 'running') running.add(step.name)
    return (
      !!transition.error ||
      transition.steps.some((step) => step.name === 'claim' && step.state === 'done')
    )
  }, 90_000)
  return { transition: last!, running }
}
const step = (transition: NonNullable<CloudInfo['transition']>, name: string) =>
  transition.steps.find((candidate) => candidate.name === name)

describe.skipIf(cloudSkip)(`cloud handoff${cloudSkip ? ` (skipped: ${cloudSkip})` : ''}`, () => {
  beforeAll(async () => {
    root = await temp('cloud-handoff-')
    repo = await repository(root, KEY, ['a', 'b'])
    git(repo.project, 'branch', 'ultimate/e2e-from-a')
    cloud = await worker(root, token)
    // B reaches the Worker through a proxy that can hold its snapshot downloads.
    proxy = await slowProxy(cloud.port)
    project = projectApi(cloud.url, KEY, token)
  }, 180_000)
  afterAll(stopAll, 60_000)

  it('registers a new project with its first machine as the writer', async () => {
    a = await host(root, 'a', {
      project: repo.project,
      cloud: cloud.url,
      token,
      settings: { idleRelease: 0, autoClaim: false },
      secrets: { ULTIMATE_CLOUD_SNAPSHOT_KEY: snapshotKey, E2E_ONLY_A: secretValue() },
    })
    await until(async () => (await project.info().catch(() => undefined))?.lease?.machine === 'a')
    await until(() => serving(a))
    expect(JSON.parse(await readFile(join(a.home, 'cloud-lease.json'), 'utf8'))).toEqual({
      key: KEY,
      epoch: 1,
    })
    for (const text of ['first', 'second']) {
      const created = await post(a.url, '/api/conversations', {})
      expect(created.status).toBe(201)
      const id = (created.data as { id: number }).id
      expect((await post(a.url, `/api/conversations/${id}/submit`, { text })).status).toBe(202)
    }
    // The faux model answers both.
    await until(() => counts(join(a.home, 'state.sqlite')).entries >= 4)
    const directory = (await (await fetch(`${cloud.url}/api/directory`)).json()) as unknown[]
    expect(directory).toEqual([
      expect.objectContaining({
        slug: 'e2e-handoff',
        writer: expect.objectContaining({ machine: 'a', online: true }),
      }),
    ])
  }, 120_000)

  it('joins a second machine on standby without opening storage', async () => {
    b = await host(root, 'b', {
      project: repo.project,
      mount: repo.clones.b,
      cloud: proxy.url,
      token,
      settings: { idleRelease: 0.1, autoClaim: false },
      secrets: { ULTIMATE_CLOUD_SNAPSHOT_KEY: snapshotKey },
    })
    await until(async () => {
      const machine = (await project.info()).machines.find((item) => item.machine === 'b')
      return machine?.connected === true
    })
    expect(
      (await project.info()).machines.find((machine) => machine.machine === 'b'),
    ).toMatchObject({
      role: 'standby',
      root: repo.project,
      missingSecrets: ['E2E_ONLY_A'],
    })
    expect(await serving(b)).toBe(false)
    expect(await files(b.home)).not.toContain('state.sqlite')
    expect(JSON.parse(await readFile(join(b.home, 'standby.json'), 'utf8'))).toEqual({
      reason: 'Waiting for the cloud',
      joining: true,
      cloud: true,
    })
  }, 120_000)

  it('moves the project to the standby: prepare, drain, release, claim', async () => {
    // A secret only the writer has stops the checks until the move is forced; A keeps serving.
    expect((await project.move({ machine: 'b' })).status).toBe(202)
    const refused = await follow()
    expect(refused.transition.error).toBe('Missing secrets: E2E_ONLY_A')
    expect(step(refused.transition, 'checks')?.state).toBe('failed')
    expect(await serving(a)).toBe(true)

    const before = counts(join(a.home, 'state.sqlite'))
    expect(before.conversations).toBeGreaterThanOrEqual(3)
    const started = await project.move({ machine: 'b', force: true })
    expect(started.status).toBe(202)
    const moved = await follow(started.data.id as string)
    expect(moved.transition).toMatchObject({ target: 'b', from: 'a' })
    expect(moved.transition.error).toBeUndefined()
    expect(moved.transition.steps.map((item) => [item.name, item.state])).toEqual([
      ['fetch', 'done'],
      ['install', 'skipped'],
      ['checks', 'done'],
      ['handover', 'done'],
      ['download', 'done'],
      ['branches', 'done'],
      ['claim', 'done'],
    ])
    expect(moved.running.size).toBeGreaterThan(0)
    await until(async () => (await project.info()).lease?.machine === 'b' && (await serving(b)))
    expect((await project.info()).lease).toMatchObject({ machine: 'b', epoch: 2, online: true })

    // A is on standby with its database kept as it was; B serves the same history and A's branches.
    expect(await serving(a)).toBe(false)
    expect(existsSync(join(a.home, 'standby.json'))).toBe(true)
    expect((await files(a.home)).filter((file) => /^state\..*sqlite$/.test(file))).toEqual([
      'state.sqlite',
    ])
    // A recorded `cloud.move` started and `cloud.lease` releasing before closing storage; the snapshot carries both.
    expect(counts(join(a.home, 'state.sqlite'))).toEqual({ ...before, entries: before.entries + 2 })
    // B holds all of A's history, and its own `ultimate.started` and `cloud.lease` acquired. On top of it: B's own notice from the refused move ("Move here failed: Missing
    // secrets"), raised on standby and recorded once B's storage opened, and the finished move reported once to B's
    // own @sync, whose standing conversation it creates and whose faux run then answers.
    const history = ids(join(a.home, 'state.sqlite'))
    await until(() => ids(join(b.home, 'state.sqlite')).moves.length === 1)
    const onB = ids(join(b.home, 'state.sqlite'))
    expect(onB.conversations).toEqual(expect.arrayContaining(history.conversations))
    expect(onB.entries).toEqual(expect.arrayContaining(history.entries))
    expect(onB.kinds).toContain('event.ultimate.notice')
    expect(onB.moves).toEqual([moved.transition.id])
    expect(onB.kinds).toEqual(
      expect.arrayContaining(['event.ultimate.started', 'event.cloud.lease', 'event.cloud.move']),
    )
    expect(git(repo.clones.b, 'rev-parse', 'refs/heads/ultimate/e2e-from-a')).toBe(
      git(repo.project, 'rev-parse', 'HEAD'),
    )
  }, 180_000)

  it('releases an idle writer, and a standby takes the free lease without a handover', async () => {
    // B releases after 0.1 idle minutes.
    await until(async () => (await project.info()).lease?.machine === null, 60_000)
    expect(await serving(b)).toBe(false)
    expect(JSON.parse(await readFile(join(b.home, 'standby.json'), 'utf8'))).toMatchObject({
      released: true,
    })
    const started = await project.move({ machine: 'a' })
    expect(started.status).toBe(202)
    const moved = await follow(started.data.id as string)
    expect(moved.transition).toMatchObject({ target: 'a', from: null })
    expect(moved.transition.error).toBeUndefined()
    expect(step(moved.transition, 'handover')?.state).toBe('skipped')
    await until(async () => (await project.info()).lease?.machine === 'a' && (await serving(a)))
    expect((await project.info()).lease).toMatchObject({ machine: 'a', epoch: 3 })
    // A took B's snapshot and recorded its start, `cloud.lease` acquired and `cloud.move` done on top.
    const released = counts(join(b.home, 'state.sqlite'))
    expect(counts(join(a.home, 'state.sqlite'))).toEqual({
      ...released,
      entries: released.entries + 3,
    })
  }, 180_000)

  it('cancels a move during its download: the lease and both databases stay, the download goes', async () => {
    const kept = counts(join(b.home, 'state.sqlite'))
    const home = await files(b.home)
    proxy.hold = Promise.withResolvers<void>()
    const started = await project.move({ machine: 'b', force: true })
    expect(started.status).toBe(202)
    await until(async () => {
      const { transition } = await project.info()
      return (
        !!transition &&
        transition.id === started.data.id &&
        step(transition, 'download')?.state === 'running'
      )
    }, 90_000)
    const lease = (await project.info()).lease
    // A released for the move: the lease is free at A's epoch and snapshot.
    expect(lease).toMatchObject({ machine: null, epoch: 3 })
    expect((await project.cancel()).status).toBe(202)
    const ended = await follow(started.data.id as string)
    proxy.hold.resolve()
    proxy.hold = undefined
    expect(ended.transition.error).toBe('Cancelled')
    expect(step(ended.transition, 'download')?.state).toBe('failed')
    expect((await project.info()).lease).toEqual(lease)
    expect(await serving(b)).toBe(false)
    expect(counts(join(b.home, 'state.sqlite'))).toEqual(kept)
    expect(await files(b.home)).toEqual(home)
    expect(counts(join(a.home, 'state.sqlite')).conversations).toBe(kept.conversations)
  }, 180_000)
})
