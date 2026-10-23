import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { chapterFiles } from '../lib/chapters.ts'
import { readJson, writeJson } from '../lib/json-file.ts'
import { CloudApi } from '../extensions/cloud/api.ts'
import type { CloudService } from '../extensions/cloud/api.ts'
import { InstanceApi } from '../extensions/instance/api.ts'
import type { InstanceService } from '../extensions/instance/api.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { docs as lineageDocs } from '../extensions/lineage/server.ts'
import { Messages } from '../extensions/messages/api.ts'
import { MessageQuestions } from '../extensions/questions/server.ts'
import { Todos } from '../extensions/todos/server.ts'
import {
  actions,
  fileJournal,
  Sessions,
  startSession,
  userActions,
} from '../extensions/dream/server.ts'
import type { Sleep } from '../extensions/dream/refs.ts'
import type { Seed } from '../extensions/dream/types.ts'
import { inspection } from './dream-fixture.ts'
import { temp } from './helpers.ts'

const harnesses: Harness[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const harness of harnesses.splice(0)) await harness.close(context)
})

async function fixture() {
  const home = await temp('ultimate-dream-asleep-')
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    context,
  )
  harnesses.push(harness)
  await harness.root(context)
  const tokens = [...lineageDocs, Messages, MessageQuestions, Todos, Sessions]
  const resources = new Map<string, unknown>()
  const phases: Sleep[] = []
  let previous = ''
  let current: Seed
  let attempts = 0
  const instances = {
    start: vi.fn<InstanceService['start']>(async ({ home: scratch }) => {
      current = (await readJson<Seed | null>(
        join(scratch, 'chapters/fresh-roots/seed.json'),
        null,
      ))!
      attempts++
      return { id: String(attempts), url: 'http://127.0.0.1:12345' }
    }),
    stop: vi.fn<InstanceService['stop']>(async () => {}),
  }
  const cloud = {
    status: vi.fn<CloudService['status']>(async () => 'on'),
    backup: vi.fn<CloudService['backup']>(async () => ({
      id: 'final',
      at: 1,
      machine: 'here',
      bytes: 1,
      uploaded: 1,
    })),
  }
  const services = new Map<unknown, unknown>([
    [InstanceApi, instances],
    [CloudApi, cloud],
  ])
  const invoke = vi.fn<(extension: string, action: string) => Promise<[]>>(
    async (extension, action) => {
      expect(action).toBe('list')
      expect(['automations', 'subscriptions']).toContain(extension)
      return []
    },
  )
  const hold = vi.fn<() => void>()
  const host = {
    home,
    chapter: { name: 'the-beginning', number: 1 },
    want: (api: unknown) => services.get(api),
    conversations: () => [],
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    harness: () => ({
      hold,
      commit: async (run: Parameters<Harness['commit']>[0]) => {
        const result = await harness.commit(run, context)
        const sleep = (await harness.snapshot(Sessions, ROOT_CONVERSATION_ID, context))?.sessions[0]
          ?.sleep
        if (sleep && JSON.stringify(sleep) !== previous) {
          phases.push(structuredClone(sleep))
          previous = JSON.stringify(sleep)
        }
        return result
      },
    }),
    doc: (kind: string) => tokens.find((token) => token.definition.kind === kind),
    invoke,
    restart: vi.fn<ExtensionHost['restart']>(async () => {
      expect(await readJson(join(home, 'pending-chapter.json'), null)).toEqual({
        to: 'fresh-roots',
        by: process.pid,
      })
      const saved = await readJson<Seed | null>(join(home, 'chapters/fresh-roots/seed.json'), null)
      expect(saved?.gate).toBeUndefined()
      expect({ ...saved, gate: true }).toEqual(current)
      return 'Restart refused'
    }),
  } as unknown as ExtensionHost
  await harness.commit(async (tx) => {
    await startSession(tx, 1)
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = 20 as never
    ;(await tx.doc(host.doc('lineage.roots')!, ROOT_CONVERSATION_ID)).roots = [1]
    ;(await tx.doc(host.doc('lineage.memory')!, ROOT_CONVERSATION_ID)).memories = {
      lesson: { kind: 'lesson', line: 'Read', body: 'Read first', updated: 1 },
    }
  }, context)
  const call = { host } as ActionContext
  const journal = (extra = {}) =>
    harness.commit(
      (tx) =>
        fileJournal(
          tx,
          {
            session: 1,
            learned: ['One', 'Two', 'Three'],
            text: 'Journal',
            chapter: 'fresh-roots',
            proposals: [],
            ...extra,
          },
          2,
        ),
      context,
    )
  const fetcher = inspection(() => current)
  return {
    host,
    home,
    harness,
    call,
    journal,
    instances,
    cloud,
    services,
    phases,
    invoke,
    fetcher,
    hold,
    current: () => current,
    attempts: () => attempts,
  }
}

it('keeps asleep and switch user-only and validates the proposed chapter before filing', async () => {
  expect(userActions).toEqual(expect.arrayContaining(['asleep', 'switch']))
  const f = await fixture()
  await expect(f.journal({ chapter: '../escape' })).rejects.toThrow('chapter name')
  await f.journal()
  expect(
    (await f.harness.snapshot(Sessions, ROOT_CONVERSATION_ID, context))?.sessions[0].journal
      ?.chapter,
  ).toBe('fresh-roots')
})

it.each(['no journal', 'open', 'approved', 'busy', 'no name', 'existing'])(
  'refuses asleep with %s before any effects',
  async (reason) => {
    const f = await fixture()
    if (reason !== 'no journal') await f.journal(reason === 'no name' ? { chapter: undefined } : {})
    if (reason === 'open' || reason === 'approved')
      await f.harness.commit(async (tx) => {
        ;(await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions[0].proposals.push({
          id: 'p',
          pass: 'tools',
          title: 'Fix',
          status: reason,
        })
      }, context)
    if (reason === 'busy')
      f.host.conversations = () => [{ id: 30, busy: true, title: 'Building' }] as never
    const args = { session: 1, ...(reason === 'existing' ? { name: 'the-beginning' } : {}) }
    const messages = {
      'no journal': 'has no journal',
      open: 'Settle every',
      approved: 'Settle every',
      busy: '#30 Building',
      'no name': 'chapter name',
      existing: 'already exists',
    }
    await expect(actions.asleep(args, f.call)).rejects.toThrow(
      messages[reason as keyof typeof messages],
    )
    expect(f.phases).toEqual([])
    expect(f.instances.start).not.toHaveBeenCalled()
    expect(f.cloud.backup).not.toHaveBeenCalled()
    expect(f.host.restart).not.toHaveBeenCalled()
  },
)

it('commits each sleep phase, takes the final backup before journaling, and records restart failure with no pending switch', async () => {
  const f = await fixture()
  await f.journal()
  f.cloud.backup.mockImplementation(async () => {
    expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
    expect(f.phases.at(-1)?.phase).toBe('backing up')
    return { id: 'final', at: 1, machine: 'here', bytes: 1, uploaded: 1 }
  })
  // @ultimate itself may be busy, as when the user invokes the action from its conversation.
  f.host.conversations = () => [{ id: 20, busy: true }] as never
  const result = await actions.asleep({ session: 1 }, f.call)
  expect(result).toMatchObject({
    session: 1,
    sleep: {
      chapter: 'fresh-roots',
      phase: 'failed',
      backup: { id: 'final' },
      error: 'Error: Restart refused',
    },
  })
  expect(f.phases.map((item) => item.phase)).toEqual([
    'seeding',
    'checking',
    'backing up',
    'backing up',
    'switching',
    'failed',
  ])
  expect(f.phases.every((item) => item.at > 0)).toBe(true)
  expect(f.phases[2].checks?.every((item) => item.ok)).toBe(true)
  expect(f.cloud.backup).toHaveBeenCalledOnce()
  expect(f.instances.stop).toHaveBeenCalledWith('1')
  expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  expect(existsSync(chapterFiles(f.home, 'fresh-roots').database)).toBe(false)
})

it.each([undefined, 'off', 'local'] as const)(
  'skips cloud with a recorded reason for %s',
  async (status) => {
    const f = await fixture()
    await f.journal({ chapter: undefined })
    if (status === undefined) f.services.delete(CloudApi)
    else f.cloud.status.mockResolvedValue(status)
    const result = await actions.asleep({ session: 1, name: 'fresh-roots' }, f.call)
    const reasons = {
      off: 'Cloud backups are off',
      local: 'Project has no GitHub origin; cloud backup is local-only',
    }
    expect(result).toMatchObject({
      sleep: {
        backup: {
          skipped: status === undefined ? 'Cloud extension is not enabled' : reasons[status],
        },
      },
    })
    expect(f.cloud.backup).not.toHaveBeenCalled()
    expect(f.host.restart).toHaveBeenCalledOnce()
  },
)

it.each([false, true])('rebuilds once after a failed gate; fail twice = %s', async (twice) => {
  const f = await fixture()
  await f.journal()
  inspection(f.current, () =>
    f.attempts() === 1 || twice ? { 'lineage.memory': { memories: {} } } : {},
  )
  const result = await actions.asleep({ session: 1 }, f.call)
  expect(f.instances.start).toHaveBeenCalledTimes(2)
  expect(f.instances.stop).toHaveBeenCalledTimes(2)
  expect(f.invoke.mock.calls.filter(([extension]) => extension === 'automations')).toHaveLength(2)
  expect(f.phases.slice(0, 4).map((item) => item.phase)).toEqual([
    'seeding',
    'checking',
    'seeding',
    'checking',
  ])
  expect(result).toMatchObject({
    sleep: {
      phase: 'failed',
      error: twice ? 'Chapter gate failed after one repair' : 'Error: Restart refused',
    },
  })
  expect(f.phases.at(-1)?.checks?.find((item) => item.name === 'memories')?.ok).toBe(!twice)
  expect(f.cloud.backup).toHaveBeenCalledTimes(twice ? 0 : 1)
  expect(f.host.restart).toHaveBeenCalledTimes(twice ? 0 : 1)
  expect(existsSync(join(f.home, 'chapters/fresh-roots/seed.json'))).toBe(!twice)
})

it('stays when the backup fails or the instance service is missing', async () => {
  const f = await fixture()
  await f.journal()
  f.cloud.backup.mockRejectedValue(new Error('Conflict'))
  expect(await actions.asleep({ session: 1 }, f.call)).toMatchObject({
    sleep: { phase: 'failed', error: 'Error: Conflict' },
  })
  expect(f.host.restart).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  f.services.delete(InstanceApi)
  expect(await actions.asleep({ session: 1 }, f.call)).toMatchObject({
    sleep: { phase: 'failed', error: expect.stringContaining('instance extension') },
  })
})

it('stays when another conversation starts during the gate or backup', async () => {
  const f = await fixture()
  await f.journal()
  f.cloud.backup.mockImplementation(async () => {
    f.host.conversations = () => [{ id: 30, busy: true, title: 'New work' }] as never
    return { id: 'final', at: 1, machine: 'here', bytes: 1, uploaded: 1 }
  })
  expect(await actions.asleep({ session: 1 }, f.call)).toMatchObject({
    sleep: {
      phase: 'failed',
      backup: { id: 'final' },
      error: expect.stringContaining('#30 New work'),
    },
  })
  expect(f.host.restart).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
})

it('lists numbered chapters and refuses active, unknown, busy and in-flight switches', async () => {
  const f = await fixture()
  await writeJson(join(f.home, 'chapters.json'), {
    active: 'the-beginning',
    chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots', createdAt: 10 }],
  })
  expect(await actions.chapters(null, f.call)).toEqual({
    active: 'the-beginning',
    number: 1,
    newest: 'fresh-roots',
    chapters: [
      { name: 'the-beginning', number: 1 },
      { name: 'fresh-roots', number: 2, createdAt: 10 },
    ],
  })
  await expect(actions.switch({ chapter: 'the-beginning' }, f.call)).rejects.toThrow(
    'already active',
  )
  await expect(actions.switch({ chapter: 'unknown' }, f.call)).rejects.toThrow('Unknown chapter')
  f.host.conversations = () => [{ id: 30, busy: true, title: 'Working' }] as never
  await expect(actions.switch({ chapter: 'fresh-roots' }, f.call)).rejects.toThrow('#30 Working')
  f.host.conversations = () => []
  const db = new DatabaseSync(join(f.home, 'state.sqlite'))
  db.exec(
    "CREATE TABLE tasks (conversation_id INTEGER, status TEXT, background INTEGER); INSERT INTO tasks VALUES (77, 'running', 0)",
  )
  db.close()
  await writeJson(join(f.home, 'chapters.json'), {
    active: 'fresh-roots',
    chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots' }],
  })
  await expect(actions.switch({ chapter: 'the-beginning' }, f.call)).rejects.toThrow(
    'work in flight',
  )
  expect(f.cloud.status).not.toHaveBeenCalled()
  expect(f.cloud.backup).not.toHaveBeenCalled()
  expect(f.host.restart).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
})

it.each(['return', 'throw'])(
  'removes the pending journal when switch restart failures %s',
  async (failure) => {
    const f = await fixture()
    await writeJson(join(f.home, 'chapters.json'), {
      active: 'the-beginning',
      chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots' }],
    })
    f.host.restart = vi.fn<ExtensionHost['restart']>(async () => {
      expect(await readJson(join(f.home, 'pending-chapter.json'), null)).toEqual({
        to: 'fresh-roots',
        by: process.pid,
      })
      if (failure === 'throw') throw new Error('Restart failed')
      return 'Restart failed'
    })
    await expect(actions.switch({ chapter: 'fresh-roots' }, f.call)).rejects.toThrow(
      'Restart failed',
    )
    expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  },
)

it.each([true, false])(
  'rechecks idleness at restart approval and holds only an idle scheduler: busy = %s',
  async (busy) => {
    const f = await fixture()
    await writeJson(join(f.home, 'chapters.json'), {
      active: 'the-beginning',
      chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots' }],
    })
    f.host.restart = vi.fn<ExtensionHost['restart']>(async (approved) => {
      f.host.conversations = () =>
        busy
          ? ([{ id: 30, busy: true, title: 'Late work' }] as never)
          : ([{ id: 20, busy: true }] as never)
      await approved(2)
      expect(f.hold).toHaveBeenCalledOnce()
      return 'Restart refused'
    })

    await expect(actions.switch({ chapter: 'fresh-roots' }, f.call)).rejects.toThrow(
      busy ? '#30 Late work' : 'Restart refused',
    )
    expect(f.host.restart).toHaveBeenCalledOnce()
    expect(f.hold).toHaveBeenCalledTimes(busy ? 0 : 1)
    expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  },
)

it.each([true, false])(
  'backs up before switch restart without recording sleep progress: cloud = %s',
  async (enabled) => {
    const f = await fixture()
    await writeJson(join(f.home, 'chapters.json'), {
      active: 'the-beginning',
      chapters: [{ name: 'the-beginning' }, { name: 'fresh-roots' }],
    })
    const before = await f.harness.snapshot(Sessions, ROOT_CONVERSATION_ID, context)
    const order: string[] = []
    if (!enabled) f.services.delete(CloudApi)
    f.cloud.backup.mockImplementation(async () => {
      expect(await readJson(join(f.home, 'pending-chapter.json'), null)).toEqual({
        to: 'fresh-roots',
        by: process.pid,
      })
      order.push('backup')
      return { id: 'final', at: 1, machine: 'here', bytes: 1, uploaded: 1 }
    })
    f.host.restart = vi.fn<ExtensionHost['restart']>(async () => {
      order.push('restart')
      return 'Restart refused'
    })

    await expect(actions.switch({ chapter: 'fresh-roots' }, f.call)).rejects.toThrow(
      'Restart refused',
    )
    expect(order).toEqual(enabled ? ['backup', 'restart'] : ['restart'])
    expect(f.cloud.backup).toHaveBeenCalledTimes(enabled ? 1 : 0)
    expect(await f.harness.snapshot(Sessions, ROOT_CONVERSATION_ID, context)).toEqual(before)
    expect(f.phases).toEqual([])
    expect(existsSync(join(f.home, 'pending-chapter.json'))).toBe(false)
  },
)

it('serializes chapter changes while the gate is starting', async () => {
  const f = await fixture()
  await f.journal()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const start = f.instances.start.getMockImplementation()!
  f.instances.start.mockImplementation(async (options) => {
    started.resolve()
    await release.promise
    return start(options)
  })
  const pending = actions.asleep({ session: 1 }, f.call)
  await started.promise
  await expect(actions.switch({ chapter: 'the-beginning' }, f.call)).rejects.toThrow(
    'already running',
  )
  await expect(actions.asleep({ session: 1 }, f.call)).rejects.toThrow('already running')
  release.resolve()
  await pending
})
