// @sync's cloud contract end to end: two faux machines against a local Worker (`cloud-helpers.ts`), driven through the
// bearer routes with the sync extension's own `fleet`, `move` and `cancel`, as @sync calls them for another machine.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cancel, fleet, move } from '../../extensions/sync/server.ts'
import type { SyncDeps } from '../../extensions/sync/server.ts'
import { until } from '../helpers.ts'
import {
  cloudSkip,
  host,
  projectApi,
  repository,
  serving,
  stopAll,
  worker,
} from './cloud-helpers.ts'
import type { Host } from './cloud-helpers.ts'
import { temp } from '../helpers.ts'

const KEY = 'github.com/hazat/e2e-sync-routes'
const token = randomBytes(16).toString('hex')
const snapshotKey = randomBytes(32).toString('base64url')
let cloud: Awaited<ReturnType<typeof worker>>
let project: ReturnType<typeof projectApi>
let a: Host
let b: Host

/** @sync on a third machine: it reaches the cloud only, with no local project homes. */
const deps = (bearer = token): SyncDeps => ({
  cloud: async () => ({ base: cloud.url, token: bearer, machine: 'sync-e2e' }),
  homes: async () => [],
  fetch: (input, init) => fetch(input, init),
  identity: async () => undefined,
  stale: async () => [],
  keptRefs: async () => [],
  health: async () => [],
})

describe.skipIf(cloudSkip)(
  `@sync bearer routes${cloudSkip ? ` (skipped: ${cloudSkip})` : ''}`,
  () => {
    beforeAll(async () => {
      const root = await temp('cloud-sync-routes-')
      const repo = await repository(root, KEY, ['a', 'b'])
      cloud = await worker(root, token)
      project = projectApi(cloud.url, 'e2e-sync-routes')
      const secrets = { ULTIMATE_CLOUD_SNAPSHOT_KEY: snapshotKey }
      a = await host(root, 'a', {
        project: repo.project,
        cloud: cloud.url,
        token,
        settings: { idleRelease: 0, autoClaim: false },
        secrets,
      })
      await until(async () => (await project.info().catch(() => undefined))?.lease?.machine === 'a')
      b = await host(root, 'b', {
        project: repo.project,
        mount: repo.clones.b,
        cloud: cloud.url,
        token,
        settings: { idleRelease: 0, autoClaim: false },
        secrets,
      })
      await until(
        async () =>
          (await project.info()).machines.find((item) => item.machine === 'b')?.connected === true,
      )
    }, 240_000)
    afterAll(stopAll, 60_000)

    it('lists the project with its writer in /sync/directory, and refuses a wrong token', async () => {
      const value = await fleet(deps())
      expect(value.error).toBeUndefined()
      expect(value.projects).toEqual([
        expect.objectContaining({
          key: KEY,
          writer: expect.objectContaining({ machine: 'a', online: true }),
          standbys: [expect.objectContaining({ machine: 'b', connected: true })],
        }),
      ])
      expect(value.machines.map((machine) => machine.machine)).toEqual(['a', 'b'])
      const refused = await fleet(deps('wrong'))
      expect(refused.error).toContain('401')
      expect(refused.projects).toEqual([])
    }, 60_000)

    it('answers 409 on /sync/cancel with nothing to cancel', async () => {
      await expect(cancel(deps(), KEY)).rejects.toThrow(/409.*nothing to cancel/)
    }, 60_000)

    it('moves the project to another machine through /sync/move until its claim is done', async () => {
      const started = await move(deps(), { project: KEY, to: 'b' })
      expect(started).toMatchObject({ key: KEY, target: 'b', local: false })
      await until(async () => {
        const { transition } = await project.info()
        return (
          transition?.id === started.id &&
          (!!transition.error ||
            transition.steps.some((step) => step.name === 'claim' && step.state === 'done'))
        )
      }, 120_000)
      const { transition, lease } = await project.info()
      expect(transition?.error).toBeUndefined()
      // The bearer route is @sync's: the deployed Worker routes it so the target records that.
      expect(transition).toMatchObject({ target: 'b', from: 'a', by: 'sync' })
      // Every step ran: the writer handed over, B downloaded its snapshot and claimed the lease.
      expect(transition?.steps.map((item) => [item.name, item.state])).toEqual([
        ['fetch', 'done'],
        ['install', 'skipped'],
        ['checks', 'done'],
        ['handover', 'done'],
        ['download', 'done'],
        ['branches', 'done'],
        ['claim', 'done'],
      ])
      expect(lease?.machine).toBe('b')
      await until(() => serving(b))
      expect(await serving(a)).toBe(false)
      const after = await fleet(deps())
      expect(after.projects[0]).toMatchObject({
        writer: { machine: 'b' },
        transition: { id: started.id },
      })
    }, 180_000)
  },
)
