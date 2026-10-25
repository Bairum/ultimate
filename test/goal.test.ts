import type { ConversationId, GenerationHooks, Tx } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { expect, it } from 'vitest'
import goalExtension, {
  act,
  end,
  Goals,
  openGoal,
  start,
  TRIES,
} from '../extensions/goal/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'

const ULTIMATE = 5 as ConversationId
const screenshot = { type: 'image', data: 'aGk=', mimeType: 'image/png' }

/** Like the harness's document overlay, a proxy at every level: structuredClone refuses it. */
const overlay = <T extends object>(value: T): T =>
  new Proxy(value, {
    get: (target, key) => {
      const found = Reflect.get(target, key) as unknown
      return found && typeof found === 'object' ? overlay(found) : found
    },
  })

/** A transaction over overlaid documents and a few entries of @ultimate's conversation; @ultimate is conversation 5. */
function fakeTx() {
  const docs = new Map<string, object>()
  const entries = [
    { id: 30, conversationId: ULTIMATE, model: [{ role: 'user', content: 'no images' }] },
    {
      id: 20,
      conversationId: ULTIMATE,
      model: [{ role: 'toolResult', content: [{ type: 'text', text: 'shot' }, screenshot] }],
    },
    { id: 10, conversationId: 9, model: [{ role: 'user', content: [screenshot] }] },
  ]
  const tasks: { input: { kind: string; content: string; to: number } }[] = []
  return {
    tasks,
    createTask: async (_definition: unknown, input: never) => {
      tasks.push({ input })
    },
    doc: async (
      { definition: def }: { definition: { kind: string; initial: () => object } },
      id: number,
    ) => {
      const key = `${def.kind}:${id}`
      if (!docs.has(key))
        docs.set(
          key,
          def.kind === 'ultimate.standing-agents' ? { ultimate: ULTIMATE } : def.initial(),
        )
      return overlay(docs.get(key)!)
    },
    entry: async (id: number) => entries.find((entry) => entry.id === id),
    scanEntries: async ({ conversationId }: { conversationId: number }) => ({
      items: entries.filter((entry) => entry.conversationId === conversationId),
    }),
  } as unknown as Tx & { tasks: typeof tasks }
}

/** The automations service: a ledger of reminders with their enabled state. */
function fakeAutomations() {
  const ledger = new Map<string, { name: string; enabled: boolean; subscribers?: number[] }>()
  let next = 1
  const service = {
    create: async (args: { name: string; subscribers?: number[] }) => {
      const id = `A${next++}`
      ledger.set(id, { ...args, enabled: true })
      return { id }
    },
    delete: async (id: string) => void ledger.delete(id),
    pause: async (id: string) => void (ledger.get(id)!.enabled = false),
    resume: async (id: string) => void (ledger.get(id)!.enabled = true),
    read: async (_tx: Tx, id: string) => ledger.get(id),
  }
  return { ledger, service }
}

it('keeps one goal open at a time and ends it once', async () => {
  const tx = fakeTx()
  await expect(start(tx, '  ', 0)).rejects.toThrow('nonempty')
  expect(await start(tx, ' Ship the sidebar ', 0)).toMatchObject({
    id: 1,
    text: 'Ship the sidebar',
  })
  await expect(start(tx, 'Another', 0)).rejects.toThrow('Goal 1 is still open')
  expect(await end(tx, { at: 1, by: 'user', outcome: 'ended' })).toMatchObject({
    ended: { by: 'user' },
  })
  await expect(end(tx, { at: 2, by: 'user', outcome: 'ended' })).rejects.toThrow('No goal')
  expect((await start(tx, 'Next', 3)).id).toBe(2)
})

it('blocks a criterion after repeated failed tries and finishes with the outcome', async () => {
  const tx = fakeTx()
  await expect(act(tx, ULTIMATE, { action: 'met', n: 1 }, 0)).rejects.toThrow('No hands-off goal')
  await start(tx, 'Goal', 0)
  await act(tx, ULTIMATE, { action: 'criteria', criteria: ['Loads in 1s', 'Tests pass'] }, 0)
  await expect(act(tx, ULTIMATE, { action: 'met', n: 3 }, 0)).rejects.toThrow('No criterion 3')
  for (let i = 1; i < TRIES; i++) await act(tx, ULTIMATE, { action: 'failed', n: 1 }, 0)
  expect((await openGoal(tx))!.criteria[0]).toMatchObject({ status: 'open', tries: TRIES - 1 })
  const last = await act(tx, ULTIMATE, { action: 'failed', n: 1 }, 0)
  expect(last.answer).toContain('blocked')
  expect((await openGoal(tx))!.criteria[0].status).toBe('blocked')
  // Rewording keeps what was learned about an unchanged criterion.
  await act(tx, ULTIMATE, { action: 'criteria', criteria: ['Loads in 1s', 'Lint passes'] }, 0)
  expect((await openGoal(tx))!.criteria.map((item) => item.status)).toEqual(['blocked', 'open'])
  await expect(act(tx, ULTIMATE, { action: 'finish', summary: 'x' }, 0)).rejects.toThrow('outcome')
  const done = await act(
    tx,
    ULTIMATE,
    { action: 'finish', outcome: 'blocked', summary: 'Stuck' },
    4,
  )
  expect(done.ended).toMatchObject({
    ended: { by: 'ultimate', outcome: 'blocked', summary: 'Stuck' },
  })
  expect(await openGoal(tx)).toBeUndefined()
})

it('records decisions with the screenshots of its own conversation only', async () => {
  const tx = fakeTx()
  await start(tx, 'Goal', 0)
  await expect(
    act(tx, ULTIMATE, { action: 'decide', question: 'Go?', picked: 'Yes' }, 0),
  ).rejects.toThrow('reason')
  await act(
    tx,
    ULTIMATE,
    {
      action: 'decide',
      question: 'Approve?',
      picked: 'Yes',
      reason: 'Meets 1',
      conversation: 7,
      images: 'latest',
    },
    1,
  )
  await expect(
    act(tx, ULTIMATE, { action: 'decide', question: 'q', picked: 'p', reason: 'r', images: 10 }, 2),
  ).rejects.toThrow('has no images')
  expect((await openGoal(tx))!.decisions).toEqual([
    { at: 1, question: 'Approve?', picked: 'Yes', reason: 'Meets 1', conversation: 7, images: 20 },
  ])
})

it("notes the open goal on @ultimate's runs only, and lets only @ultimate keep it", async () => {
  const tx = fakeTx()
  const extension = goalExtension({
    doc: () => undefined,
    need: () => undefined,
  } as unknown as ExtensionHost)
  const hooks = extension.hooks![0].handlers as GenerationHooks
  const before = (conversationId: number, kind = 'pi.user') =>
    hooks.beforeInput({ kind }, { tx, conversationId } as never, BACKGROUND_CONTEXT)
  expect(await before(ULTIMATE)).toBeUndefined()
  await start(tx, 'Make it fast', 0)
  expect(await before(9)).toBeUndefined()
  const note = (await before(ULTIMATE))!.entries![0]
  expect(note.kind).toBe('goal.note')
  expect(note.model![0].content).toContain(
    'Hands-off goal 1, granted by the user, who is away: Make it fast',
  )

  const tool = extension.tools!.find((candidate) => candidate.name === 'goal')!
  const run = (conversationId: number, args: object) =>
    tool.execute(
      args as never,
      { conversationId, commit: (fn: (tx: Tx) => unknown) => fn(tx) } as never,
      undefined as never,
    )
  await expect(run(9, { action: 'met', n: 1 })).rejects.toThrow('Only @ultimate')
  expect(await run(ULTIMATE, { action: 'criteria', criteria: ['Fast'] })).toEqual({
    output: [{ type: 'text', text: 'Goal 1 has 1 criteria.' }],
  })
  expect((await tx.doc(Goals, 1 as ConversationId)).goals[0].criteria).toHaveLength(1)

  // Finishing ends the goal and creates the report's delivery in the same commit; the note stops.
  await run(ULTIMATE, { action: 'finish', outcome: 'met', summary: 'Done' })
  expect(tx.tasks.map((task) => task.input)).toEqual([
    expect.objectContaining({ to: ULTIMATE, kind: 'goal.report', goal: 1 }),
  ])
  expect(await before(ULTIMATE)).toBeUndefined()
})

it('keeps a reminder while the goal is open: paused while waiting on the user, gone once ended', async () => {
  const tx = fakeTx()
  const { ledger, service } = fakeAutomations()
  const host = {
    harness: () => ({ commit: (fn: (tx: Tx) => unknown) => fn(tx) }),
    need: () => service,
    doc: () => undefined,
  } as unknown as ExtensionHost
  const { actions } = await import('../extensions/goal/server.ts')
  const extension = goalExtension(host)
  const tool = extension.tools!.find((candidate) => candidate.name === 'goal')!
  const run = (args: object) =>
    tool.execute(
      args as never,
      { conversationId: ULTIMATE, commit: (fn: (tx: Tx) => unknown) => fn(tx) } as never,
      undefined as never,
    )
  const goal = await actions.start({ text: 'Make it fast' }, { host } as never)
  expect(goal.reminder).toBe('A1')
  expect(ledger.get('A1')).toEqual({
    name: 'Goal reminder',
    schedule: 'every 30m',
    subscribers: [ULTIMATE],
    enabled: true,
  })

  // Its fire tells @ultimate what to check; other inputs do not.
  const hooks = extension.hooks![0].handlers as GenerationHooks
  const note = async (input: object) =>
    (await hooks.beforeInput(input as never, { tx, conversationId: ULTIMATE }, BACKGROUND_CONTEXT))!
      .entries![0].model![0].content as string
  expect(await note({ kind: 'automations.fired', data: { id: 'A1' } })).toContain(
    'This is the goal reminder',
  )
  expect(await note({ kind: 'pi.user' })).not.toContain('This is the goal reminder')

  await expect(run({ action: 'pause' })).rejects.toThrow('reason')
  await expect(run({ action: 'resume' })).rejects.toThrow('not paused')
  await run({ action: 'pause', reason: 'Which account to deploy to?' })
  expect(ledger.get('A1')!.enabled).toBe(false)
  expect((await openGoal(tx))!.waiting).toMatchObject({ reason: 'Which account to deploy to?' })
  expect(await note({ kind: 'pi.user' })).toContain('Waiting on the user')
  await run({ action: 'resume' })
  expect(ledger.get('A1')!.enabled).toBe(true)
  expect((await openGoal(tx))!.waiting).toBeUndefined()

  await run({ action: 'finish', outcome: 'met', summary: 'Done' })
  expect(ledger.size).toBe(0)
  await actions.start({ text: 'Again' }, { host } as never)
  await actions.end(null, { host } as never)
  expect(ledger.size).toBe(0)
})

it('grants nothing through a start card still queued after the user ended its goal', async () => {
  const tx = fakeTx()
  const { service } = fakeAutomations()
  const host = {
    harness: () => ({ commit: (fn: (tx: Tx) => unknown) => fn(tx) }),
    need: () => service,
  } as unknown as ExtensionHost
  const extension = goalExtension(host)
  const actions = await import('../extensions/goal/server.ts').then((module) => module.actions)
  await actions.start({ text: 'Make it fast' }, { host } as never)
  await actions.end(null, { host } as never)
  const [started, report] = tx.tasks.map((task) => task.input)
  expect(started).toMatchObject({
    kind: 'goal.started',
    content: 'The user started hands-off goal 1.',
  })
  expect(report).toMatchObject({ kind: 'goal.report' })
  expect(report.content).toContain('ask them as usual')
  // The queued start runs now: no goal is open, so no note says to decide for the user.
  const hooks = extension.hooks![0].handlers as GenerationHooks
  expect(
    await hooks.beforeInput(
      { kind: 'goal.started' },
      { tx, conversationId: ULTIMATE },
      BACKGROUND_CONTEXT,
    ),
  ).toBeUndefined()
})
