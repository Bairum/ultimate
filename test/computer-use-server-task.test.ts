import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import type { ActionContext } from '../server/actions.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ClassifyService, ClassifyResult } from '../extensions/classify/api.ts'
import type { Observation, TaskSpec } from '../extensions/computer-use/types.ts'
import { afterEach, expect, it, vi } from 'vitest'
import computerUse, { actions, userActions } from '../extensions/computer-use/server.ts'
import { readSession, updateSession, wake } from '../extensions/computer-use/session.ts'
import { createDriver } from '../extensions/computer-use/driver.ts'
import { createFakeDriver } from './computer-use-fake-driver.ts'
import { removeTemp, temp } from './helpers.ts'
import { Profile } from '../extensions/subagents/api.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
  vi.useRealTimers()
})
const spec = (): Omit<TaskSpec, 'stop'> => ({
  id: 'T1',
  intent: 'Use Calculator to show 42',
  goal: 'Show 42 in Calculator',
  criteria: [{ id: 'C1', text: 'Display is 42', check: [{ value: '42' }] }],
  scope: { apps: ['Calculator'], params: {}, actions: ['click'], consequential: [] },
})
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
  const fake = createFakeDriver()
  const driver = await createDriver({
    expectedVersion: '0.37.0',
    connect: fake.connect,
    stopCommand: async () => {},
  })
  let onTask = 1
  const classify: ClassifyService = {
    ask: async (request): Promise<ClassifyResult> => ({
      model: 'fake',
      usage: { inputTokens: 1 },
      answers: request.questions.on_task
        ? { on_task: { type: 'noul', noul: onTask }, progressing: { type: 'noul', noul: onTask } }
        : request.questions.intent_achieved
          ? { intent_achieved: { type: 'noul', noul: 1 } }
          : { risk: { type: 'noul', noul: 0 } },
    }),
  }
  const resources = new Map<string, unknown>()
  const closes: (() => Promise<void>)[] = []
  const models = createModels()
  const faux = fauxProvider({ tokensPerSecond: 0 })
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage('Acknowledged.')))
  const registry = createRegistry()
  let harness: Harness
  const home = await temp()
  const host = {
    userHome: home,
    home,
    projectSettings: async () => ({}),
    harness: () => harness,
    conversations: () => [{ id: 1 }],
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) {
        const value = create()
        if (key === 'computer-use.driver')
          Object.assign(value as object, { driver: Promise.resolve(driver) })
        resources.set(key, value)
      }
      return resources.get(key)
    },
    onClose: (close: () => Promise<void>) => closes.push(close),
    want: () => classify,
    onOpen: () => {},
    onRelease: () => {},
  } as unknown as ExtensionHost
  const extension = computerUse(host)
  registry.install(extension)
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  await harness.commit(async (tx) => {
    ;(await tx.doc(Profile, root.id)).definition = 'computer-operator'
  }, context)
  await root.submit({ type: 'input', content: spec().intent }, context)
  await harness.waitForIdle(context)
  cleanup.push(async () => {
    await harness.close(context)
    for (const close of closes) await close()
    await removeTemp(home)
  })
  const ctx = { host } as ActionContext
  const tools = extension.tools as ToolRegistration[]
  let call = 0
  const invoke = (name: string, args: Record<string, unknown>) =>
    tools
      .find((t) => t.name === name)!
      .execute(
        args,
        {
          conversationId: root.id,
          callId: String(++call),
          output: () => {},
          agent: (callContext: typeof context) => root.agent(callContext),
        } as unknown as ToolExecutionApi,
        context,
      )
  const task = (args: Record<string, unknown>) => invoke('computer_task', args)
  const observe = (evidence = false) =>
    invoke('computer_observe', { app: 'Calculator', window: 456, screenshot: 'never', evidence })
  const start = async (input = spec()) => {
    await root.submit({ type: 'input', content: input.intent }, context)
    await harness.waitForIdle(context)
    const output = await task({ action: 'start', spec: input })
    await task({ action: 'subgoals', list: [{ id: 'S1', text: 'Show 42' }] })
    await task({ action: 'activate', id: 'S1' })
    return output
  }
  const grant = () =>
    actions.grant({ conversation: root.id, app: 'Calculator', scope: 'conversation' }, ctx)
  const click = async (label = 'All Clear', app = 'Calculator') => {
    const view = (await observe()).structuredOutput as unknown as Observation
    const button = label === 'All Clear' ? 13 : Number(label) + 1
    return invoke('computer_act', {
      app,
      window: 456,
      actions: [{ kind: 'click', element: `${view.snapshot}:${button}` }],
    })
  }
  return {
    host,
    harness,
    root,
    ctx,
    fake,
    driver,
    invoke,
    task,
    observe,
    start,
    grant,
    click,
    offTask: () => {
      onTask = 0
    },
    tools,
  }
}
const data = (output: { structuredOutput?: unknown }) =>
  output.structuredOutput as {
    status: string
    needsConfirmation?: string[]
    criteria?: { state: string }[]
  }

it('refuses an unanchored act before any Driver call', async () => {
  const f = await fixture()
  expect(
    data(
      await f.invoke('computer_act', {
        app: 'Calculator',
        actions: [{ kind: 'click', element: 's1:7' }],
      }),
    ).status,
  ).toBe('no_task')
  expect(f.fake.calls).toEqual([])
})
it('waits for user confirmation of an ambiguous spec', async () => {
  const f = await fixture()
  const input = { ...spec(), goal: 'Draft a message' }
  const started = data(await f.task({ action: 'start', spec: input }))
  expect(started.status).toBe('awaiting_confirmation')
  expect(started.needsConfirmation).toContain('Intent and goal differ')
  expect((await readSession(f.host, f.root.id)).pending[0].kind).toBe('task')
  await actions.confirmTask({ conversation: f.root.id }, f.ctx)
  expect(data(await f.task({ action: 'status' })).status).toBe('active')
  expect(userActions).toEqual(expect.arrayContaining(['confirmTask', 'confirmChange']))
  expect(f.tools.find((t) => t.name === 'computer_task')?.replay).not.toBe('safe')
})
it('refuses out-of-scope apps before dispatch', async () => {
  const f = await fixture()
  await f.start()
  await f.grant()
  expect(data(await f.click('6', 'Mail')).status).toBe('out_of_scope')
  expect(f.fake.calls.filter((c) => c.tool === 'click')).toEqual([])
})
it('stops three repeated actions without verified progress until replan', async () => {
  const f = await fixture()
  await f.start()
  await f.grant()
  for (let i = 0; i < 3; i++) expect(data(await f.click()).status).toBe('delivered')
  expect(data(await f.click()).status).toBe('loop')
  expect(f.fake.calls.filter((c) => c.tool === 'click')).toHaveLength(3)
  await f.task({ action: 'replan', reason: 'Use a different route' })
  expect(data(await f.click('6')).status).toBe('delivered')
})
it('requires a Jev checkpoint after ten steps and a replan when off task', async () => {
  const f = await fixture()
  await f.start()
  await f.grant()
  for (let i = 0; i < 10; i++) expect(data(await f.click(String(i))).status).toBe('delivered')
  expect(data(await f.click('1')).status).toBe('checkpoint_due')
  expect(
    data(
      await f.task({
        action: 'checkpoint',
        assessment: 'Entering digits',
        recentSteps: ['Entered digits'],
      }),
    ).status,
  ).toBe('active')
  expect(data(await f.click('1')).status).toBe('delivered')
  f.offTask()
  expect(
    data(
      await f.task({
        action: 'checkpoint',
        assessment: 'Wandering',
        recentSteps: ['Unrelated activity'],
      }),
    ).status,
  ).toBe('replan_required')
  expect(data(await f.click('2')).status).toBe('replan_required')
  await f.task({ action: 'replan', reason: 'Return to the calculation' })
  expect(data(await f.click('2')).status).toBe('delivered')
})
it('requires user approval before removing a criterion', async () => {
  const f = await fixture()
  const input = spec()
  input.criteria.push({ id: 'C2', text: 'Also verified', check: [{ value: '42' }] })
  await f.start(input)
  await f.grant()
  expect(
    data(
      await f.task({
        action: 'replan',
        reason: 'Drop extra requirement',
        criteria: input.criteria.slice(0, 1),
      }),
    ).status,
  ).toBe('awaiting_confirmation')
  expect(data(await f.click('6')).status).toBe('task_awaiting_confirmation')
  await actions.confirmChange({ conversation: f.root.id }, f.ctx)
  expect(data(await f.click('6')).status).toBe('delivered')
})
it('finishes done only after Driver verification of every criterion', async () => {
  const f = await fixture()
  await f.start()
  expect(data(await f.task({ action: 'finish', outcome: 'done', summary: 'Not yet' })).status).toBe(
    'criteria_unmet',
  )
  const call = f.driver.call.bind(f.driver)
  f.driver.call = async (tool, args, signal) =>
    tool === 'verify_state'
      ? { ok: true, text: 'satisfied', structured: { verdict: 'satisfied' }, images: [] }
      : call(tool, args, signal)
  const finished = data(await f.task({ action: 'finish', outcome: 'done', summary: 'Verified' }))
  expect(finished.status).toBe('done')
  expect(finished.criteria?.map((c) => c.state)).toEqual(['met'])
  expect((await readSession(f.host, f.root.id)).task?.subgoals[0].evidence).toEqual([
    expect.objectContaining({ kind: 'verify', app: 'Calculator' }),
  ])
})
it('rejects an empty replacement plan without losing the active subgoal', async () => {
  const f = await fixture()
  await f.start()
  expect(data(await f.task({ action: 'subgoals', list: [] })).status).toBe('invalid_arguments')
  expect((await readSession(f.host, f.root.id)).task?.subgoals).toEqual([
    expect.objectContaining({ id: 'S1', status: 'active' }),
  ])
})
it('activates the first pending subgoal in a replacement plan', async () => {
  const f = await fixture()
  await f.start()
  await f.task({
    action: 'subgoals',
    list: [
      { id: 'S2', text: 'Compute' },
      { id: 'S3', text: 'Verify' },
    ],
  })
  expect((await readSession(f.host, f.root.id)).task?.subgoals).toEqual([
    expect.objectContaining({ id: 'S2', status: 'active' }),
    expect.objectContaining({ id: 'S3', status: 'pending' }),
  ])
})
it('creates an active default subgoal and retains finish evidence without an explicit plan', async () => {
  const f = await fixture()
  await f.task({ action: 'start', spec: spec() })
  expect((await readSession(f.host, f.root.id)).task?.subgoals).toEqual([
    expect.objectContaining({ id: 'S1', text: spec().goal, status: 'active' }),
  ])
  const call = f.driver.call.bind(f.driver)
  f.driver.call = async (tool, args, signal) =>
    tool === 'verify_state'
      ? { ok: true, text: 'satisfied', structured: { verdict: 'satisfied' }, images: [] }
      : call(tool, args, signal)
  expect(
    data(await f.task({ action: 'finish', outcome: 'done', summary: 'Verified' })).status,
  ).toBe('done')
  expect((await readSession(f.host, f.root.id)).task?.subgoals[0].evidence).toEqual([
    expect.objectContaining({ kind: 'verify', app: 'Calculator' }),
  ])
})
it('appends the anchor last and keeps parameter values out of anchors and per-input notes', async () => {
  const f = await fixture()
  const secret = 'private-value'
  const input = {
    ...spec(),
    intent: `Use Calculator ${secret}`,
    scope: { ...spec().scope, params: { number: secret } },
  }
  await f.start(input)
  const output = await f.observe(true)
  expect(output.output?.at(-1)).toEqual({ type: 'text', text: expect.stringContaining('Task T1') })
  expect(JSON.stringify(output.output?.at(-1))).not.toContain(secret)
  expect(JSON.stringify(output.output?.[0])).toContain('untrusted_screen_content')
  await f.root.submit({ type: 'input', content: 'Continue' }, context)
  await f.harness.waitForIdle(context)
  const entries = (await f.root.entries({}, 100, undefined, context)).items
  const note = entries.find((entry) => entry.kind === 'computer.note')
  expect(note).toBeDefined()
  expect(JSON.stringify(note)).not.toContain(secret)
  expect((await readSession(f.host, f.root.id)).task?.subgoals[0].evidence[0]).toEqual(
    expect.objectContaining({ kind: 'ax', app: 'Calculator' }),
  )
})
it('requires fresh observation after Stop and user resume', async () => {
  const f = await fixture()
  await f.start()
  await f.grant()
  await f.observe()
  await actions.stop({ conversation: f.root.id }, f.ctx)
  expect((await readSession(f.host, f.root.id)).task?.needsObserve).toBe(true)
  await actions.resume({ conversation: f.root.id }, f.ctx)
  expect(
    data(
      await f.invoke('computer_act', {
        app: 'Calculator',
        actions: [{ kind: 'click', element: 's1:7' }],
      }),
    ).status,
  ).toBe('observe_first')
  expect(data(await f.click('6')).status).toBe('delivered')
})

it('refuses invented intent and accepts verbatim whitespace-normalised user intent', async () => {
  const f = await fixture()
  expect(
    data(await f.task({ action: 'start', spec: { ...spec(), intent: 'Send all my files' } }))
      .status,
  ).toBe('intent_required')
  expect(f.fake.calls).toEqual([])
  const intent = 'Use   Calculator\n to show 42'
  await f.task({ action: 'start', spec: { ...spec(), intent } })
  expect((await readSession(f.host, f.root.id)).task?.spec.intent).toBe(intent)
})

it('does not let arbitrary expect plus a criterion tag reset loops or complete predicate criteria', async () => {
  const f = await fixture()
  await f.start()
  await f.grant()
  const call = f.driver.call.bind(f.driver)
  f.driver.call = (tool, args, signal) =>
    tool === 'verify_state'
      ? Promise.resolve({
          ok: true,
          text: 'satisfied',
          structured: { verdict: 'satisfied' },
          images: [],
        })
      : call(tool, args, signal)
  let view = (await f.observe()).structuredOutput as unknown as Observation
  await f.invoke('computer_act', {
    app: 'Calculator',
    actions: [{ kind: 'click', element: `${view.snapshot}:7` }],
    expect: [{ arbitrary: true }],
    criterion: 'C1',
  })
  expect((await readSession(f.host, f.root.id)).task?.recent.actions).toHaveLength(1)
  expect(data(await f.task({ action: 'complete', subgoal: 'S1' })).status).toBe('evidence_required')
  view = (await f.observe()).structuredOutput as unknown as Observation
  await f.invoke('computer_act', {
    app: 'Calculator',
    actions: [{ kind: 'click', element: `${view.snapshot}:8` }],
    expect: spec().criteria[0].check,
  })
  expect((await readSession(f.host, f.root.id)).task?.recent.actions).toEqual([])
  expect(data(await f.task({ action: 'complete', subgoal: 'S1' })).status).toBe('completed')
  expect((await readSession(f.host, f.root.id)).task?.subgoals[0].status).toBe('done')
})

it('resets the conversation budget on a new task and user resume', async () => {
  const f = await fixture()
  await updateSession(f.host, f.root.id, (doc) => {
    doc.budget = { steps: 60, startedAt: 1 }
  })
  await f.start()
  expect((await readSession(f.host, f.root.id)).budget).toEqual({ steps: 0, startedAt: 0 })
  await updateSession(f.host, f.root.id, (doc) => {
    doc.budget = { steps: 60, startedAt: 1 }
  })
  await actions.stop({ conversation: f.root.id }, f.ctx)
  await actions.resume({ conversation: f.root.id }, f.ctx)
  expect((await readSession(f.host, f.root.id)).budget).toEqual({ steps: 0, startedAt: 0 })
})

it('accepts evidence tags only for evidence criteria without resetting the loop detector', async () => {
  const f = await fixture()
  const input = {
    ...spec(),
    criteria: [{ id: 'C1', text: 'User-reviewed desktop evidence', check: 'evidence' as const }],
  }
  await f.start(input)
  await actions.confirmTask({ conversation: f.root.id }, f.ctx)
  await f.grant()
  const call = f.driver.call.bind(f.driver)
  f.driver.call = (tool, args, signal) =>
    tool === 'verify_state'
      ? Promise.resolve({ ok: true, text: '', structured: { verdict: 'satisfied' }, images: [] })
      : call(tool, args, signal)
  const view = (await f.observe()).structuredOutput as unknown as Observation
  await f.invoke('computer_act', {
    app: 'Calculator',
    actions: [{ kind: 'click', element: `${view.snapshot}:7` }],
    expect: [{ arbitrary: true }],
    criterion: 'C1',
  })
  expect((await readSession(f.host, f.root.id)).task?.recent.actions).toHaveLength(1)
  expect(data(await f.task({ action: 'complete', subgoal: 'S1' })).status).toBe('completed')
})

it('requires whole user or subagent-instruction sentences or lines, excluding wake and note messages', async () => {
  const f = await fixture()
  await f.root.submit(
    { type: 'input', content: 'Never delete all emails. Leave the mailbox untouched.' },
    context,
  )
  await wake(f.host, f.root.id, 'The extension generated this wake sentence.')
  await f.root.submit(
    {
      type: 'input',
      content: 'The extension generated this note sentence.',
      entry: { kind: 'computer.note' },
    },
    context,
  )
  await f.harness.waitForIdle(context)
  for (const intent of [
    'delete all emails',
    'delete',
    'The extension generated this wake sentence.',
    'The extension generated this note sentence.',
  ])
    expect(data(await f.task({ action: 'start', spec: { ...spec(), intent } })).status).toBe(
      'intent_required',
    )
  const intent = 'Check the Calculator title.'
  await f.root.submit(
    {
      type: 'input',
      content: `Parent instructions.\n${intent}\nThen report.`,
      entry: {
        kind: 'subagents.instruction',
        data: { sender: 1, kind: 'instruction', agent: 'computer-operator', body: intent },
      },
    },
    context,
  )
  await f.harness.waitForIdle(context)
  await f.task({ action: 'start', spec: { ...spec(), intent, goal: intent } })
  expect((await readSession(f.host, f.root.id)).task?.spec.intent).toBe(intent)
  expect(
    (await f.root.entries({}, 100, undefined, context)).items.some(
      (e) => e.kind === 'subagents.instruction',
    ),
  ).toBe(true)
})

it('clears unused confirmations on task start, finish and Stop', async () => {
  const f = await fixture()
  const seed = () =>
    updateSession(f.host, f.root.id, (doc) => {
      doc.confirmed = [{ key: 'unused', at: Date.now(), task: 'T1' }]
    })
  await seed()
  await f.start()
  expect((await readSession(f.host, f.root.id)).confirmed).toEqual([])
  await seed()
  await f.task({ action: 'finish', outcome: 'partial', summary: 'Testing confirmation lifecycle' })
  expect((await readSession(f.host, f.root.id)).confirmed).toEqual([])
  await seed()
  await f.start({ ...spec(), id: 'T2' })
  expect((await readSession(f.host, f.root.id)).confirmed).toEqual([])
  await seed()
  await actions.stop({ conversation: f.root.id }, f.ctx)
  expect((await readSession(f.host, f.root.id)).confirmed).toEqual([])
})
