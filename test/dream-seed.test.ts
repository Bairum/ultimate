import { join } from 'node:path'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { requestChapter } from '../lib/chapters.ts'
import { context, prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import { Metadata } from '../server/metadata.ts'
import { docs as lineageDocs } from '../extensions/lineage/server.ts'
import { Messages } from '../extensions/messages/api.ts'
import { MessageQuestions } from '../extensions/questions/server.ts'
import { Todos } from '../extensions/todos/server.ts'
import { Standing } from '../extensions/subagents/api.ts'
import automations, {
  actions as automationActions,
  Automations,
} from '../extensions/automations/server.ts'
import type { Subscription } from '../extensions/subscriptions/types.ts'
import dream, { Sessions, fileJournal, startSession } from '../extensions/dream/server.ts'
import { applySeed, buildSeed, SeedState, writeSeed } from '../extensions/dream/seed.ts'
import { temp, until } from './helpers.ts'

const openedHosts: OpenHost[] = []
afterEach(async () => {
  for (const opened of openedHosts.splice(0)) await opened.close()
})

async function fixture() {
  const home = await temp('ultimate-dream-seed-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  let opener: () => Promise<void>
  let subscriptions: Subscription[] = []
  const tokens = [...lineageDocs, Messages, MessageQuestions, Todos, Sessions]
  const host = {
    ...prepared,
    get chapter() {
      return prepared.chapter
    },
    harness: () => opened.harness,
    metadata: Metadata,
    extensions: () => [{ name: 'subagents', enabled: true }],
    doc: (kind: string) => tokens.find((token) => token.definition.kind === kind),
    onOpen: (callback: () => Promise<void>) => {
      opener = callback
    },
    react: () => {},
    need: () => ({
      standing: async () =>
        opened.harness.commit(async (tx) => {
          const standing = await tx.doc(Standing, ROOT_CONVERSATION_ID)
          if (!standing.ultimate) {
            const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
            await configure(tx, created.id, {})
            standing.ultimate = created.id
          }
          return standing.ultimate
        }, context),
    }),
    invoke: async (extension: string, action: string, args: unknown) => {
      if (extension === 'subscriptions' && action === 'list') return subscriptions
      if (extension !== 'automations' || (action !== 'list' && action !== 'create'))
        throw new Error(`Unexpected action ${extension}/${action}`)
      return automationActions[action](args as never, { host } as ActionContext)
    },
  } as unknown as ExtensionHost
  prepared.registry.install(automations(host))
  prepared.registry.install(dream(host))
  const open = async () => {
    opened = await prepared.open(false)
    openedHosts.push(opened)
    await opener()
  }
  const close = async () => {
    openedHosts.splice(openedHosts.indexOf(opened), 1)
    await opened.close()
  }
  await open()
  return {
    home,
    host,
    open,
    close,
    get harness() {
      return opened.harness
    },
    subscriptions: (items: Subscription[]) => {
      subscriptions = items
    },
    async source() {
      await opened.harness.commit(async (tx) => {
        const roots = host.doc('lineage.roots')!
        ;(await tx.doc(roots, ROOT_CONVERSATION_ID)).roots = [1]
        const memory = host.doc('lineage.memory')!
        ;(await tx.doc(memory, ROOT_CONVERSATION_ID)).memories = {
          'about-daniel': {
            kind: 'fact',
            line: 'Daniel',
            body: 'Keep user context.',
            source: '#123/456',
            updated: 10,
          },
          lesson: { kind: 'lesson', line: 'Read first', body: 'Read the code.', updated: 20 },
          // A valid slug that a plain object would shadow with its prototype's.
          constructor: { kind: 'fact', line: 'Builds', body: 'Constructors.', updated: 30 },
        }
        const todos = await tx.doc(Todos, ROOT_CONVERSATION_ID)
        todos.items.push(
          { id: 1, text: 'Keep this', owner: 'ultimate', at: 1 },
          { id: 2, text: 'Finished', owner: 'user', at: 1, done: 2 },
        )
        todos.next = 3
        const board = await tx.doc(Messages, ROOT_CONVERSATION_ID)
        for (const [id, state] of [
          [100, 'delivered'],
          [101, 'answered'],
          [102, 'dismissed'],
        ] as const) {
          board.messages.push({
            id,
            from: 1,
            to: 'user',
            text: `Question ${id}`,
            at: 1,
            reply: true,
            state,
          })
          ;(await tx.doc(MessageQuestions, ROOT_CONVERSATION_ID)).asked[String(id)] = [
            { text: `Choose ${id}?`, kind: 'confirm' },
          ]
        }
        // Open, but its questions were never extracted: the message itself is the question.
        board.messages.push({
          id: 103,
          from: 1,
          to: 'user',
          text: 'Question 103',
          at: 1,
          reply: true,
          state: 'delivered',
        })
        await startSession(tx, 1)
        await fileJournal(
          tx,
          {
            session: 1,
            learned: ['I learned one.', 'I keep two.', "I'd like three."],
            text: 'The journal.',
            proposals: [{ id: 'keep', title: 'Keep it', pass: 'memory' }],
          },
          2,
        )
      }, context)
    },
  }
}

it('carries the seed into a fresh chapter once, including user memory and its passive chapter entry', async () => {
  const f = await fixture()
  await f.source()
  await f.host.invoke(
    'automations',
    'create',
    { name: 'Daily', prompt: 'Review', schedule: 'every 1d' },
    new AbortController().signal,
  )
  f.subscriptions([
    { id: 'S1', title: 'Watch it', ask: 'Watch the build', enabled: true },
    { id: 'build-watch', scope: 'project', title: 'Project watch', ask: 'Watch CI', enabled: true },
    { id: 'S2', title: 'Stopped', ask: 'Ignore', enabled: false },
  ] as Subscription[])
  const seed = await buildSeed(f.host, 1)
  expect(seed.counts).toEqual({
    memories: 3,
    todos: 1,
    questions: 2,
    automations: 1,
    subscriptions: 2,
  })
  expect(seed.memories.constructor).toMatchObject({ line: 'Builds' })
  expect(seed.journal.proposals[0].status).toBe('open')
  expect(seed.questions).toEqual([
    { text: 'Choose 100?', ref: '#100' },
    { text: 'Question 103', ref: '#103' },
  ])
  expect(seed.todos).toEqual([{ text: 'Keep this', owner: 'ultimate' }])
  expect(seed.automations).toEqual([
    { name: 'Daily', prompt: 'Review', schedule: { kind: 'every', ms: 86400000 } },
  ])
  await writeSeed(join(f.home, 'chapters', 'fresh-roots'), seed)
  await f.close()
  await requestChapter(f.home, 'fresh-roots')
  await f.open()
  const contents = async () => ({
    memory: (await f.harness.snapshot(
      f.host.doc('lineage.memory')!,
      ROOT_CONVERSATION_ID,
      context,
    ))!,
    todos: (await f.harness.snapshot(Todos, ROOT_CONVERSATION_ID, context))!,
    seed: (await f.harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))!,
    automations: (await f.harness.snapshot(Automations, context))!,
  })
  const after = await contents()
  expect(after.memory.memories).toEqual(seed.memories)
  expect((after.memory.memories as typeof seed.memories)['about-daniel'].source).toBe('#123/456')
  expect(after.todos.items.map(({ text, owner }) => ({ text, owner }))).toEqual([
    { text: 'Keep this', owner: 'ultimate' },
    { text: 'Open question (the-beginning#100): Choose 100?', owner: 'user' },
    { text: 'Open question (the-beginning#103): Question 103', owner: 'user' },
    { text: 'Recreate subscription S1 (Watch it): Watch the build', owner: 'ultimate' },
  ])
  expect(after.todos.next).toBe(5)
  expect(after.seed.applied).toBeGreaterThan(0)
  expect(after.seed.automations).toEqual(['Daily'])
  const chapterEntries = async () => {
    const standing = await f.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context)
    return f.harness.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId: standing!.ultimate }, 100)).items.filter(
          (entry) => entry.kind === 'dream.chapter',
        ),
      context,
    )
  }
  await until(async () => (await chapterEntries()).length === 1)
  const entry = (await chapterEntries())[0]
  expect(entry.data).toEqual({ from: seed.from, number: 2, name: 'fresh-roots', session: 1 })
  expect(JSON.stringify(entry.model)).toContain('the-beginning#123')
  for (const line of seed.journal.learned) expect(JSON.stringify(entry.model)).toContain(line)
  expect(JSON.stringify(entry.model)).toContain(
    '3 memories, 1 todos, 2 questions, 1 automations, 2 subscriptions',
  )
  // Simulate the crash window: creation committed but dream did not record its automation receipt.
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(SeedState, ROOT_CONVERSATION_ID)).automations = []
  }, context)
  await applySeed(f.host)
  expect(
    Object.values((await contents()).automations.automations).map((item) => item.name),
  ).toEqual(['Daily'])
  await f.close()
  await f.open()
  const again = await contents()
  expect(again.memory).toEqual(after.memory)
  expect(again.todos).toEqual(after.todos)
  expect(again.seed).toEqual(after.seed)
  expect(again.automations).toEqual(after.automations)
  expect(await chapterEntries()).toEqual([entry])
})

it('rolls back the entire application when a required document is unavailable', async () => {
  const f = await fixture()
  await f.source()
  const seed = await buildSeed(f.host, 1)
  await writeSeed(join(f.home, 'chapters', 'retry'), seed)
  await f.close()
  await requestChapter(f.home, 'retry')
  const resolve = f.host.doc.bind(f.host)
  f.host.doc = (kind) => (kind === 'todos' ? undefined : resolve(kind))
  await expect(f.open()).rejects.toThrow('Chapter seed needs document todos')
  expect(
    (await f.harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))?.applied,
  ).toBeUndefined()
  expect(
    (await f.harness.snapshot(resolve('lineage.memory')!, ROOT_CONVERSATION_ID, context))
      ?.memories ?? {},
  ).toEqual({})
  expect(
    (await f.harness.commit((tx) => tx.scanTasks({ kind: 'dream.deliver' }, 10), context)).items,
  ).toHaveLength(0)
  f.host.doc = resolve
  await applySeed(f.host)
  expect(
    (await f.harness.snapshot(resolve('lineage.memory')!, ROOT_CONVERSATION_ID, context))!.memories,
  ).toEqual(seed.memories)
  expect(
    (await f.harness.snapshot(SeedState, ROOT_CONVERSATION_ID, context))!.applied,
  ).toBeGreaterThan(0)
})

it('merges root memories by updated, maps automation options, and rejects duplicate schedule names', async () => {
  const f = await fixture()
  await f.source()
  await f.harness.commit(async (tx: Tx) => {
    const root = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    ;(await tx.doc(f.host.doc('lineage.roots')!, ROOT_CONVERSATION_ID)).roots = [1, root.id]
    ;(await tx.doc(f.host.doc('lineage.memory')!, root.id)).memories = {
      lesson: { kind: 'lesson', line: 'Newer', body: 'Use the latest.', updated: 30 },
    }
  }, context)
  await f.host.invoke(
    'automations',
    'create',
    { name: 'Review', prompt: 'Read', schedule: 'every 1d', thinking: 'high' },
    new AbortController().signal,
  )
  let seed = await buildSeed(f.host, 1)
  expect(seed.memories.lesson.line).toBe('Newer')
  expect(seed.memories['about-daniel']).toBeDefined()
  expect(seed.automations[0].thinking).toBe('high')
  await f.harness.commit(async (tx) => {
    const records = (await tx.doc(Automations)).automations
    records.A1.agent = 'reviewer'
    records.A1.model = { provider: 'faux', modelId: 'test' }
    records.A2 = { ...records.A1, id: 'A2', name: 'Paused', enabled: false }
  }, context)
  seed = await buildSeed(f.host, 1)
  expect(seed.automations).toHaveLength(1)
  expect(seed.automations[0]).toMatchObject({
    agent: 'reviewer',
    model: { provider: 'faux', modelId: 'test' },
    thinking: 'high',
  })
  await f.harness.commit(async (tx) => {
    const records = (await tx.doc(Automations)).automations
    records.A2 = { ...records.A1, id: 'A2' }
  }, context)
  await expect(buildSeed(f.host, 1)).rejects.toThrow('unique automation names: Review')
  await expect(buildSeed(f.host, 99)).rejects.toThrow('Dream session 99 has no journal')
})
