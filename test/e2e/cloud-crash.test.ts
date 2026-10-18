// Crashes in the middle of a move, with real processes against `wrangler dev` (`cloud-helpers.ts`): the target killed
// right after its claim, the holder killed mid-upload. After a restart exactly one machine writes, with the history the
// holder had, and no transition keeps running.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { post, temp, until } from '../helpers.ts'
import {
  cloudSkip,
  counts,
  crash,
  host,
  projectApi,
  repository,
  serving,
  stopAll,
  worker,
} from './cloud-helpers.ts'
import type { Host } from './cloud-helpers.ts'

const token = randomBytes(16).toString('hex')
const snapshotKey = randomBytes(32).toString('base64url')
let base: string
let cloud: Awaited<ReturnType<typeof worker>>

/** A project of its own for one test: its repository with clones for the desk and the laptop, and its API. */
async function project(name: string) {
  const root = join(base, name)
  await mkdir(root)
  const repo = await repository(root, `github.com/hazat/${name}`, ['desk', 'laptop'])
  const api = projectApi(cloud.url, name)
  const start = (machine: 'desk' | 'laptop', settings: Record<string, unknown> = {}) =>
    host(root, machine, {
      project: repo.project,
      ...(machine === 'laptop' ? { mount: repo.clones.laptop } : {}),
      cloud: cloud.url,
      token,
      settings: { idleRelease: 0, ...settings },
      secrets: { ULTIMATE_CLOUD_SNAPSHOT_KEY: snapshotKey },
    })
  return { api, start }
}
type Api = ReturnType<typeof projectApi>
/** The desk writes the project, with three conversations besides its root. */
async function holder(api: Api, start: Awaited<ReturnType<typeof project>>['start']) {
  const desk = await start('desk')
  await until(async () => (await api.info().catch(() => undefined))?.lease?.machine === 'desk')
  await until(() => serving(desk))
  for (const title of ['one', 'two', 'three'])
    expect((await post(desk.url, '/api/conversations', { title })).status).toBe(201)
  return desk
}
/** `machine` alone writes, serving `conversations`; the move ended; no claim or download is left behind. */
async function writes(api: Api, machine: Host, conversations: number) {
  await until(async () => {
    const info = await api.info()
    const writers = info.machines.filter((item) => item.role === 'writer')
    return (
      info.lease?.machine === machine.name &&
      writers.length === 1 &&
      writers[0].connected &&
      (await serving(machine)) &&
      counts(join(machine.home, 'state.sqlite')).conversations === conversations
    )
  }, 120_000)
  const { transition } = await api.info()
  expect(
    !transition ||
      !!transition.error ||
      transition.steps.some((step) => step.name === 'claim' && step.state === 'done'),
  ).toBe(true)
  expect(existsSync(join(machine.home, 'cloud-claim.json'))).toBe(false)
  expect((await readdir(machine.home)).filter((file) => file.startsWith('snapshot-'))).toEqual([])
}

describe.skipIf(cloudSkip)(`cloud crash${cloudSkip ? ` (skipped: ${cloudSkip})` : ''}`, () => {
  beforeAll(async () => {
    base = await temp('cloud-crash-')
    cloud = await worker(base, token)
  }, 180_000)
  afterAll(stopAll, 60_000)

  it('recovers a target killed right after its claim', async () => {
    const { api, start } = await project('crash-target')
    const desk = await holder(api, start)
    const history = counts(join(desk.home, 'state.sqlite')).conversations
    // A clean stop releases the lease with a snapshot.
    desk.child.kill('SIGTERM')
    await until(async () => {
      const { lease } = await api.info()
      return lease?.machine === null && !!lease.snapshot
    }, 60_000)
    // A starting machine prepares and claims the free lease by itself, and dies the moment the claim is granted.
    const laptop = await start('laptop')
    await until(async () => (await api.info()).lease?.machine === 'laptop', 120_000)
    await crash(laptop)
    const restarted = await start('laptop')
    await writes(api, restarted, history)
    expect((await api.info()).lease?.epoch).toBe(2)
  }, 300_000)

  it('recovers when the holder is killed mid-upload of a move', async () => {
    const { api, start } = await project('crash-holder')
    const desk = await holder(api, start)
    const history = counts(join(desk.home, 'state.sqlite')).conversations
    const laptop = await start('laptop', { autoClaim: false })
    await until(async () =>
      (await api.info()).machines.some((item) => item.machine === 'laptop' && item.connected),
    )
    expect((await api.move({ machine: 'laptop' })).status).toBe(202)
    // The holder snapshots into a `.snapshot-*` folder of its home; it dies while that exists.
    await until(
      async () => (await readdir(desk.home)).some((file) => file.startsWith('.snapshot-')),
      120_000,
    )
    await crash(desk)
    const restarted = await start('desk')
    // Killed before its release reached the cloud, the holder writes again and the move ends; killed after it, the
    // laptop takes over. Either way one machine writes the same history.
    await until(async () => {
      const { lease } = await api.info()
      return lease?.machine === 'desk' || lease?.machine === 'laptop'
    }, 120_000)
    const writer = (await api.info()).lease?.machine === 'desk' ? restarted : laptop
    await writes(api, writer, history)
    await until(async () => !(await serving(writer === laptop ? restarted : laptop)))
  }, 300_000)
})
