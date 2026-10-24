import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { writeJson } from '../lib/json-file.ts'
import { prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import { Metadata } from '../server/metadata.ts'
import { docs as lineageDocs } from '../extensions/lineage/server.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Todos } from '../extensions/todos/server.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { Compacted } from '../extensions/conversations/refs.ts'
import automations, {
  actions as automationActions,
  Automations,
} from '../extensions/automations/server.ts'
import dream, { actions, fileJournal, Sessions, startSession } from '../extensions/dream/server.ts'
import {
  AfterCompactionDoc,
  ASLEEP_AFTER,
  asleepAfter,
  AUTOMATION_NAME,
  compactionDream,
  DREAM_WAIT_MS,
  ensureAutomation,
} from '../extensions/dream/after-compaction.ts'
import { buildSeed } from '../extensions/dream/seed.ts'
import type { Session } from '../extensions/dream/refs.ts'
import { apis, eventHost, temp, until } from './helpers.ts'

const openedHosts: OpenHost[] = []
afterEach(async () => {
  for (const opened of openedHosts.splice(0)) await opened.close()
})

async function fixture() {
  const home = await temp('ultimate-dream-compaction-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  const openers: (() => Promise<void>)[] = []
  const tokens = [...lineageDocs, Messages, Todos, Sessions]
  const resources = new Map<string, unknown>()
  const events = eventHost(() => opened.harness, 'test')
  let busy: { id: number; busy: boolean; title: string }[] = []
  const notes: { to: number; text: string }[] = []
  const notices: string[] = []
  const services = apis(
    new Map<string, unknown>([
      ['messages', { send: async () => ({}) }],
      [
        'lineage',
        {
          rootOf: async () => undefined,
          leaveNote: async (to: number, text: string) => void notes.push({ to, text }),
        },
      ],
      [
        'subagents',
        {
          standing: async () =>
            (await opened.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!.ultimate,
        },
      ],
    ]),
  )
  const invoke = vi.fn<ExtensionHost['invoke']>(async (extension, action, args) => {
    if (extension !== 'automations') throw new Error(`Unexpected ${extension}/${action}`)
    return automationActions[action as 'list'](args, { host } as ActionContext)
  })
  const host = {
    ...prepared,
    ...events,
    ...services,
    get chapter() {
      return prepared.chapter
    },
    harness: () => opened.harness,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    metadata: Metadata,
    onRelease: () => {},
    onClose: () => {},
    onOpen: (callback: () => Promise<void>) => void openers.push(callback),
    projectSetup: async () => ({ decision: false }),
    projectSettings: async () => ({}),
    extensions: () => [
      { name: 'subagents', enabled: true },
      { name: 'automations', enabled: true },
    ],
    conversations: () => busy,
    doc: (kind: string) =>
      tokens.find((token) => token.definition.kind === kind) ?? events.doc(kind),
    notice: (message: string) => void notices.push(message),
    invoke,
  } as unknown as ExtensionHost
  prepared.registry.install(automations(host))
  prepared.registry.install(dream(host))
  opened = await prepared.open(false)
  openedHosts.push(opened)
  const ultimate = await opened.harness.commit(async (tx) => {
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, created.id, {})
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = created.id
    return created.id
  }, context)
  for (const open of openers) await open()
  await events.start()
  const harness = opened.harness
  const call = { host } as ActionContext
  const sessions = async () =>
    (await harness.snapshot(Sessions, ROOT_CONVERSATION_ID, context))?.sessions ?? []
  const own = async () =>
    (await harness.snapshot(AfterCompactionDoc, ROOT_CONVERSATION_ID, context))?.id
  const record = async (id: string) =>
    (await harness.snapshot(Automations, context))!.automations[id]
  const compact = (conversation: number) =>
    harness.commit(async (tx) => {
      const entry = await tx.appendEntry(conversation as ConversationId, {
        kind: 'pi.compaction',
        data: { reason: 'threshold' },
        model: [
          {
            role: 'user',
            content:
              'The conversation history before this point was compacted into the following summary:\n\n<summary>\nI was building dream after compaction (#355131).\n\n<project_memory root="#1">\nabout-daniel\n</project_memory>\n</summary>',
            timestamp: 0,
          },
        ],
      })
      await host.emit(tx, Compacted, {
        conversation,
        entry: entry.id,
      })
    }, context)
  const waits = () =>
    harness.commit(
      async (tx) =>
        (
          await tx.scanTasks(
            { conversationId: ROOT_CONVERSATION_ID, kind: 'dream.after-compaction' },
            10,
          )
        ).items,
      context,
    )
  const deps = {
    Sessions,
    switching: () =>
      (resources.get('dream.switching') as { busy: boolean } | undefined)?.busy ?? false,
    start:
      vi.fn<(tx: Tx, after: Session['afterCompaction'] & object) => Promise<{ session: number }>>(),
    grantedSleep: vi.fn<(tx: Tx, by: unknown, input: { session?: number }) => Promise<unknown>>(
      async () => ({ session: 1 }),
    ),
  }
  return {
    host,
    harness,
    home,
    ultimate,
    call,
    sessions,
    own,
    record,
    compact,
    waits,
    notes,
    notices,
    invoke,
    deps,
    busy: (items: typeof busy) => {
      busy = items
    },
    settle: () => until(events.settled),
    action: (name: keyof typeof automationActions, args: JsonValue = {}) =>
      automationActions[name](args, {
        host,
        conversationId: ultimate,
      } as unknown as ActionContext),
  }
}

it('ships one enabled "Dream after compaction" automation that wakes @ultimate, and keeps a deletion', async () => {
  const f = await fixture()
  const id = (await f.own())!
  const made = await f.record(id)
  expect(made).toMatchObject({
    name: AUTOMATION_NAME,
    enabled: true,
    event: { name: 'conversations.compacted', where: { conversation: '@ultimate' } },
    subscribers: [f.ultimate],
  })
  expect(made.grant).toBeUndefined()
  // Opening again (a facet reload, a restart) makes no second one.
  await ensureAutomation(f.host)
  expect(Object.values((await f.harness.snapshot(Automations, context))!.automations)).toHaveLength(
    1,
  )
  // The user deletes it: it stays deleted.
  await f.action('delete', { id })
  await ensureAutomation(f.host)
  expect((await f.harness.snapshot(Automations, context))!.automations).toEqual({})
  expect(await f.harness.snapshot(AfterCompactionDoc, ROOT_CONVERSATION_ID, context)).toMatchObject(
    {
      deleted: true,
    },
  )
})

it("starts one wait on @ultimate's compaction, none for another conversation's or while one waits", async () => {
  const f = await fixture()
  f.busy([{ id: 50, busy: true, title: 'A branch at work' }])
  await f.compact(1)
  await f.settle()
  expect(await f.waits()).toEqual([])
  await f.compact(f.ultimate)
  await f.compact(f.ultimate)
  await f.settle()
  expect((await f.record((await f.own())!)).fires).toBe(2)
  // Two compactions while the first still waits: one wait.
  expect(await f.waits()).toHaveLength(1)
})

it('finds a wait that sleeps between looks, so another compaction starts no second one', async () => {
  const f = await fixture()
  f.busy([{ id: 50, busy: true, title: 'A branch at work' }])
  f.host.harness().resume()
  await f.compact(f.ultimate)
  await f.settle()
  // The scheduler runs the first look: busy, so the wait sleeps until the next one.
  await until(async () => (await f.waits())[0]?.state.status === 'sleeping')
  await f.compact(f.ultimate)
  await f.settle()
  expect((await f.record((await f.own())!)).fires).toBe(2)
  expect(await f.waits()).toHaveLength(1)
})

it('waits for idle, then starts the session through the Dream path, and times out with a quiet note', async () => {
  const f = await fixture()
  const { look } = compactionDream(f.host, f.deps)
  f.deps.start.mockImplementation(async (tx, after) => {
    const { startDreamIn } = await import('../extensions/dream/server.ts')
    return startDreamIn(f.host, tx, undefined, undefined, after)
  })
  const input = { automation: (await f.own())!, name: AUTOMATION_NAME, deadline: 1000 }
  f.busy([{ id: 50, busy: true, title: 'A branch at work' }])
  // @ultimate's own turn is not work in progress: only another conversation's is.
  expect(await look(input, 9, 10)).toBe('look')
  expect(await f.sessions()).toEqual([])
  // Past the deadline: gives up, leaves @ultimate a note, starts nothing, even with nothing else at work.
  f.busy([])
  expect(await look(input, 9, 1000)).toBe('done')
  expect(f.notes).toEqual([{ to: f.ultimate, text: expect.stringContaining('did not start') }])
  expect(await f.sessions()).toEqual([])
  f.busy([{ id: f.ultimate, busy: true, title: '@ultimate' }])
  expect(await look(input, 10, 20)).toBe('started')
  const [started] = await f.sessions()
  expect(started.afterCompaction).toEqual({
    automation: input.automation,
    name: AUTOMATION_NAME,
    at: 20,
  })
  expect(started.by).toBeUndefined()
  // A session is open now: a second fire does nothing and starts no second session.
  expect(await look(input, 11, 30)).toBe('done')
  expect(await f.sessions()).toHaveLength(1)
  expect(DREAM_WAIT_MS).toBe(2 * 3600_000)
})

it('does nothing while a chapter change runs or a sleep is under way', async () => {
  const f = await fixture()
  const { look } = compactionDream(f.host, f.deps)
  const input = { automation: (await f.own())!, name: AUTOMATION_NAME, deadline: 1000 }
  const lock = f.host.resource('dream.switching', () => ({ busy: false }))
  lock.busy = true
  expect(await look(input, 1, 10)).toBe('done')
  lock.busy = false
  await f.harness.commit(async (tx) => {
    await startSession(tx, 1)
    const doc = await tx.doc(Sessions, ROOT_CONVERSATION_ID)
    doc.sessions[0].endedAt = 2
    doc.sessions[0].sleep = { chapter: 'next', phase: 'checking', at: 2 }
  }, context)
  expect(await look(input, 2, 20)).toBe('done')
  expect(f.deps.start).not.toHaveBeenCalled()
})

it('starts nothing once its automation is paused or deleted', async () => {
  const f = await fixture()
  const { look } = compactionDream(f.host, f.deps)
  const id = (await f.own())!
  const input = { automation: id, name: AUTOMATION_NAME, deadline: 1000 }
  await f.action('pause', { id })
  expect(await look(input, 1, 10)).toBe('done')
  await f.action('delete', { id })
  expect(await look(input, 2, 20)).toBe('done')
  expect(f.deps.start).not.toHaveBeenCalled()
})

it('tells @ultimate to decide by itself only under a dream grant', async () => {
  const f = await fixture()
  const { look } = compactionDream(f.host, f.deps)
  const id = (await f.own())!
  f.deps.start.mockResolvedValue({ session: 1 })
  const input = { automation: id, name: AUTOMATION_NAME, deadline: 1000 }
  await look(input, 1, 10)
  expect(f.deps.start.mock.calls[0][1]).not.toHaveProperty('handsOff')
  await automationActions.grant({ id, actions: ['dream'] }, f.call)
  await look(input, 2, 20)
  expect(f.deps.start.mock.calls[1][1]).toMatchObject({ handsOff: true })
})

/** A compaction's session with `applied` applied proposals and the rest rejected, all settled. */
async function settledSession(f: Awaited<ReturnType<typeof fixture>>, applied: number) {
  await f.harness.commit(async (tx) => {
    await startSession(tx, 1, undefined, {
      automation: (await f.own())!,
      name: AUTOMATION_NAME,
      at: 1,
    })
    await fileJournal(
      tx,
      {
        session: 1,
        learned: ['One', 'Two', 'Three'],
        text: 'Journal',
        chapter: 'fresh-roots',
        proposals: Array.from({ length: 6 }, (_, index) => ({
          id: `p${index}`,
          pass: 'memory',
          title: `Proposal ${index}`,
        })),
      },
      2,
    )
  }, context)
  for (let index = 0; index < 6; index++)
    await actions.decide(
      {
        session: 1,
        proposal: `p${index}`,
        status: index < applied ? 'applied' : 'rejected',
      },
      f.call,
    )
}

it.each([
  [ASLEEP_AFTER - 1, false, 'stay'],
  [ASLEEP_AFTER, false, 'ask'],
  [ASLEEP_AFTER, true, 'asleep'],
] as const)(
  'settles %i changes with an asleep grant %s as %s, and never switches without one',
  async (applied, grant, result) => {
    const f = await fixture()
    const id = (await f.own())!
    if (grant) await automationActions.grant({ id, actions: ['asleep'] }, f.call)
    const { settle } = compactionDream(f.host, f.deps)
    await settledSession(f, applied)
    const [found] = await f.sessions()
    // The last decide settled the session and created its check exactly once.
    expect(found.endedAt).toBeDefined()
    expect(found.afterCompaction?.settling).toBeTypeOf('number')
    await settle(1)
    const [after] = await f.sessions()
    expect(after.afterCompaction?.outcome).toMatchObject({
      changes: applied,
      threshold: ASLEEP_AFTER,
      result,
    })
    // Only the grant falls asleep, and as the automation, for this session.
    const asleep = [
      [expect.objectContaining({ automation: id, name: AUTOMATION_NAME }), { session: 1 }],
    ]
    expect(f.deps.grantedSleep.mock.calls.map(([, by, input]) => [by, input])).toEqual(
      result === 'asleep' ? asleep : [],
    )
    // Settling twice decides once.
    await settle(1)
    expect(f.deps.grantedSleep.mock.calls.length).toBe(result === 'asleep' ? 1 : 0)
    // Only asking wakes @ultimate; the other outcomes are passive.
    const submitted = () =>
      f.harness.commit((tx) => tx.submissionByRequest(f.ultimate, 'dream.settled:1'), context)
    await until(async () => (await submitted()) !== undefined)
    expect((await submitted())?.type).toBe(result === 'ask' ? 'input' : 'write')
  },
)

it('asks instead of sleeping once the granted automation is paused', async () => {
  const f = await fixture()
  const id = (await f.own())!
  await automationActions.grant({ id, actions: ['asleep'] }, f.call)
  await f.action('pause', { id })
  const { settle } = compactionDream(f.host, f.deps)
  await settledSession(f, ASLEEP_AFTER)
  await settle(1)
  expect((await f.sessions())[0].afterCompaction?.outcome?.result).toBe('ask')
  expect(f.deps.grantedSleep).not.toHaveBeenCalled()
})

it('never adopts a same-name automation that watches other compactions', async () => {
  const f = await fixture()
  await f.action('delete', { id: (await f.own())! })
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(AfterCompactionDoc, ROOT_CONVERSATION_ID)
    delete doc.id
    delete doc.deleted
  }, context)
  const other = (await f.action('create', {
    name: AUTOMATION_NAME,
    event: { name: 'conversations.compacted' },
  })) as { id: string }
  await ensureAutomation(f.host)
  const id = (await f.own())!
  expect(id).not.toBe(other.id)
  expect((await f.record(id)).event?.where).toEqual({ conversation: '@ultimate' })
})

it('adopts its own automation after a lost receipt, even with changed subscribers and paused', async () => {
  const f = await fixture()
  const id = (await f.own())!
  await f.action('unsubscribe', { id })
  await f.action('pause', { id })
  // The create committed but its receipt was lost.
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(AfterCompactionDoc, ROOT_CONVERSATION_ID)).id
  }, context)
  await ensureAutomation(f.host)
  expect(await f.own()).toBe(id)
  expect(Object.keys((await f.harness.snapshot(Automations, context))!.automations)).toEqual([id])
  expect((await f.record(id)).enabled).toBe(false)
})

it('keeps a chapter seed paused whichever check runs first', async () => {
  const f = await fixture()
  // A fresh chapter whose seed carried the automation paused, before any check made it.
  await f.action('delete', { id: (await f.own())! })
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(AfterCompactionDoc, ROOT_CONVERSATION_ID)
    delete doc.id
    delete doc.deleted
  }, context)
  await writeJson(`${f.host.chapter.dir}/seed.json`, { afterCompaction: { enabled: false } })
  // The standing reactor's check runs without the seed in hand: it reads the seed itself.
  await ensureAutomation(f.host)
  const id = (await f.own())!
  expect((await f.record(id)).enabled).toBe(false)
  // A seed whose chapter had deleted it makes none.
  await f.action('delete', { id })
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(AfterCompactionDoc, ROOT_CONVERSATION_ID)
    delete doc.id
  }, context)
  await writeJson(`${f.host.chapter.dir}/seed.json`, { afterCompaction: null })
  await ensureAutomation(f.host)
  expect((await f.harness.snapshot(Automations, context))!.automations).toEqual({})
})

it('makes it in a chapter whose seed predates the feature', async () => {
  const f = await fixture()
  await f.action('delete', { id: (await f.own())! })
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(AfterCompactionDoc, ROOT_CONVERSATION_ID)
    delete doc.id
    delete doc.deleted
  }, context)
  await writeJson(`${f.host.chapter.dir}/seed.json`, { session: 1 })
  await ensureAutomation(f.host)
  expect((await f.record((await f.own())!)).enabled).toBe(true)
})

it('asks the user when the asleep grant is refused', async () => {
  const f = await fixture()
  const id = (await f.own())!
  await automationActions.grant({ id, actions: ['asleep'] }, f.call)
  f.deps.grantedSleep.mockRejectedValue(new Error('Dream session 1 is already falling asleep'))
  const { settle } = compactionDream(f.host, f.deps)
  await settledSession(f, ASLEEP_AFTER)
  await settle(1)
  expect((await f.sessions())[0].afterCompaction?.outcome).toMatchObject({
    result: 'ask',
    error: expect.stringContaining('already falling asleep'),
  })
})

it('reads dream.asleepAfter from project over user settings, and rejects nonsense', async () => {
  const home = await temp('ultimate-asleep-after-')
  const host = (project: object) =>
    ({ userHome: home, projectSettings: async () => project }) as unknown as ExtensionHost
  expect(await asleepAfter(host({}))).toBe(ASLEEP_AFTER)
  await writeJson(`${home}/.ultimate/settings.json`, { dream: { asleepAfter: 3 } })
  expect(await asleepAfter(host({}))).toBe(3)
  expect(await asleepAfter(host({ dream: { asleepAfter: 8 } }))).toBe(8)
  await expect(asleepAfter(host({ dream: { asleepAfter: 0 } }))).rejects.toThrow(
    'Invalid dream.asleepAfter',
  )
})

it("carries @ultimate's compaction summary, without its memory, and the automation into the next chapter's seed", async () => {
  const f = await fixture()
  await f.compact(f.ultimate)
  await settledSession(f, 1)
  const id = (await f.own())!
  await f.action('pause', { id })
  const seed = await buildSeed(f.host, 1)
  expect(seed.continues).toEqual({
    conversation: f.ultimate,
    summary: 'I was building dream after compaction (#355131).',
  })
  expect(seed.afterCompaction).toEqual({ enabled: false })
  // The built-in automation is dream's own: it is not carried as an ordinary one.
  expect(seed.automations).toEqual([])
  // A dream the user started carries no summary.
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions[0].afterCompaction
  }, context)
  expect((await buildSeed(f.host, 1)).continues).toBeUndefined()
})
