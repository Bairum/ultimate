import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  UsageDoc,
} from '@earendil-works/pi-durable'
import type { CommitPublication, GenerationHooks } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Summaries, summaryBehavior } from '../extensions/conversations/summary.ts'
import { until } from './helpers.ts'

const reported: Usage = {
  input: 300,
  output: 100,
  cacheRead: 10,
  cacheWrite: 0,
  totalTokens: 410,
  reasoning: 40,
  cost: { input: 0.03, output: 0.05, cacheRead: 0.001, cacheWrite: 0, total: 0.081 },
}
const other: Usage = {
  input: 70,
  output: 20,
  cacheRead: 5,
  cacheWrite: 10,
  totalTokens: 105,
  cacheWrite1h: 6,
  reasoning: 8,
  cost: { input: 0.007, output: 0.01, cacheRead: 0.0005, cacheWrite: 0.001, total: 0.0185 },
}
const key = 'openai-codex/gpt-6-luna'
const valid = JSON.stringify({
  assessment: 'done',
  activity: 'Implemented the requested change.',
  title: 'Implement the requested change',
  summary: 'Implemented the requested change.',
})
type Plan = {
  usage?: Usage
  text?: string
  error?: boolean
  held?: boolean
  interruptAfterReceipt?: boolean
  throws?: boolean
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function launch(plans: Plan[]) {
  const models = createModels()
  const main = fauxProvider({ tokensPerSecond: 100000 })
  const luna = fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'gpt-6-luna', reasoning: true }],
  })
  const calls: { systemPrompt?: string; release(): void }[] = []
  models.setProvider(main.provider)
  models.setProvider({
    ...luna.provider,
    streamSimple(model, input, options) {
      expect(model.provider).toBe('openai-codex')
      expect(model.id).toBe('gpt-6-luna')
      expect(options?.reasoning).toBe('medium')
      const plan = plans[calls.length]
      if (!plan) throw new Error('Unexpected helper request')
      const stream = createAssistantMessageEventStream()
      // Override the faux factory's zero cost with explicit provider-reported usage.
      const answer = {
        ...fauxAssistantMessage(plan.text ?? valid),
        provider: model.provider,
        model: model.id,
        api: model.api,
        usage: plan.usage,
        stopReason: plan.error ? 'error' : 'stop',
      } as AssistantMessage
      const release = () => {
        if (plan.error) stream.push({ type: 'error', reason: 'error', error: answer })
        else stream.push({ type: 'done', reason: 'stop', message: answer })
        stream.end(answer)
      }
      const system = input.messages.find((message) => message.role === 'system')?.content
      calls.push({
        systemPrompt:
          typeof system === 'string' ? system : system?.map((part) => part.text).join(''),
        release,
      })
      if (plan.throws) throw new Error('Provider failed without a response')
      if (plan.held) {
        stream.push({ type: 'start', partial: answer })
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: plan.text ?? valid,
          partial: answer,
        })
      } else queueMicrotask(release)
      return stream
    },
  })
  const storage = new MemoryStorage()
  // Retain the in-memory database between real Harness close/open cycles.
  storage.close = async () => {}
  const registry = createRegistry()
  let harness: Harness
  const behavior = summaryBehavior({ harness: () => harness, metadata: Metadata })
  registry.install(defineExtension({ name: 'conversations', ...behavior }))
  harness = await Harness.open(storage, { models, registry }, context)
  const commits: CommitPublication[] = []
  let interruption: Promise<void> | undefined
  harness.subscribeCommits((publication) => {
    commits.push(publication)
    if (
      !interruption &&
      plans[calls.length - 1]?.interruptAfterReceipt &&
      publication.changes.some(
        (change) => change.type === 'task' && change.value.memos?.response !== undefined,
      )
    )
      interruption = harness.close(context)
  })
  let root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  cleanups.push(async () => {
    for (const call of calls) call.release()
    await harness.close(context)
  })
  const read = (conversation = root) => harness.snapshot(Summaries, conversation.id, context)
  const ledger = (conversation = root) => harness.snapshot(UsageDoc, conversation.id, context)
  const submit = async (conversation = root) => {
    main.setResponses([fauxAssistantMessage('Implemented the requested change.')])
    expect(
      (
        await (
          await conversation.submit({ type: 'input', content: 'Implement this change.' }, context)
        ).wait(context)
      ).status,
    ).toBe('done')
  }
  const finish = async (conversation = root) => {
    const before = (await read(conversation))?.lastAnswer
    await submit(conversation)
    await until(
      async () =>
        (await read(conversation))?.lastAnswer !== before && !(await read(conversation))?.pending,
    )
  }
  return {
    get harness() {
      return harness
    },
    get root() {
      return root
    },
    calls,
    commits,
    get interruption() {
      return interruption
    },
    read,
    ledger,
    submit,
    finish,
    replayYield: async () => {
      const taskId = (await read())!.lastYield!
      await (behavior.hooks[0].handlers as Partial<GenerationHooks>).onYield!(
        fauxAssistantMessage('Implemented the requested change.'),
        { taskId, conversationId: root.id } as never,
        context,
      )
    },
    reopen: async (rejectSaved?: 'stale' | 'abort') => {
      await (interruption ?? harness.close(context))
      interruption = undefined
      harness = await Harness.open(storage, { models, registry }, context)
      harness.subscribeCommits((publication) => commits.push(publication))
      root = await harness.root(context)
      if (rejectSaved === 'stale')
        await harness.commit(async (tx) => {
          const state = await tx.doc(Summaries, root.id)
          state.revision++
          delete state.pending
          state.assessmentStatus = 'error'
        }, context)
      if (rejectSaved === 'abort') await root.abort(context, { background: true })
      harness.resume()
    },
    child: async () => {
      const anchor = defineTask<null, { phase: 'done' }, null>({
        name: 'usage-anchor',
        version: 1,
        initial: () => ({ phase: 'done' }),
        phases: {
          done: async (_task, runtime, caller) => {
            await runtime.commit(
              () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
              caller,
            )
          },
        },
        abort: async (_task, runtime, caller) => {
          await runtime.commit(
            () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
            caller,
          )
        },
      })
      registry.install(defineExtension({ name: 'usage-anchor', tasks: [anchor] }))
      const child = await harness.commit(async (tx) => {
        const owner = await tx.createTask(anchor, null, {
          ownership: { kind: 'conversation' },
          conversationId: root.id,
          background: true,
        })
        const created = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
        await configure(tx, created.id, { model: { provider: 'faux', modelId: 'faux-1' } })
        return created
      }, context)
      return (await harness.conversation(child.id, context))!
    },
  }
}

it('accounts the default combined and assessment-only responses, preserving model buckets and optional counters', async () => {
  const fixture = await launch([{ usage: reported, held: true }, { usage: reported }])
  await fixture.harness.commit(async (tx) => {
    const ledger = await tx.doc(UsageDoc, fixture.root.id)
    ledger.models[key] = structuredClone(other)
    ledger.models['existing/model'] = structuredClone(reported)
  }, context)
  await fixture.submit()
  await until(() => fixture.calls.length === 1)
  const before = await fixture.ledger()
  expect(before?.models[key]).toEqual(other)
  fixture.calls[0].release()
  await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
  await fixture.finish()
  expect(fixture.calls).toHaveLength(2)
  expect(fixture.calls[0].systemPrompt).toContain('Also include')
  expect(fixture.calls[1].systemPrompt).toContain('Do not include title or summary')
  const ledger = (await fixture.ledger())!
  expect(ledger.models['existing/model']).toEqual(before?.models['existing/model'])
  expect(ledger.models['faux/faux-1'].totalTokens).toBeGreaterThan(0)
  expect(ledger.tools).toEqual({})
  expect(ledger.models[key]).toMatchObject({
    input: 670,
    output: 220,
    cacheRead: 25,
    cacheWrite: 10,
    totalTokens: 925,
    reasoning: 88,
    cacheWrite1h: 6,
  })
  for (const counter of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
    expect(ledger.models[key].cost[counter]).toBeCloseTo(
      other.cost[counter] + 2 * reported.cost[counter],
      12,
    )
})

it('charges an owned child only to its own default assessment model ledger', async () => {
  const fixture = await launch([{ usage: reported }])
  await fixture.harness.commit(async (tx) => {
    const ledger = await tx.doc(UsageDoc, fixture.root.id)
    ledger.models[key] = structuredClone(other)
  }, context)
  const child = await fixture.child()
  const rootBefore = await fixture.ledger()
  await fixture.finish(child)
  expect((await fixture.read(child))?.assessmentStatus).toBe('ready')
  expect((await fixture.read(child))?.summary).toBeUndefined()
  expect(fixture.calls[0].systemPrompt).toContain('Do not include title or summary')
  expect((await fixture.ledger(child))?.models[key]).toEqual(reported)
  expect(await fixture.ledger()).toEqual(rootBefore)
})

it.each([
  { name: 'invalid JSON', text: 'not JSON' },
  {
    name: 'invalid assessment',
    text: JSON.stringify({ assessment: 'blocked', activity: 'Blocked.' }),
  },
  { name: 'oversized output', text: 'x'.repeat(2050) },
  { name: 'provider error', error: true },
])(
  'accounts a received $name response even when parsing or provider validation fails, and counts a real new retry response',
  async (plan) => {
    const fixture = await launch([{ ...plan, usage: reported }, { usage: other }])
    await fixture.finish()
    expect((await fixture.read())?.assessmentStatus).toBe('error')
    expect((await fixture.ledger())?.models[key]).toEqual(reported)
    await fixture.reopen()
    expect((await fixture.ledger())?.models[key]).toEqual(reported)
    expect(fixture.calls).toHaveLength(1)
    await fixture.finish()
    expect((await fixture.read())?.assessmentStatus).toBe('ready')
    const total = (await fixture.ledger())!.models[key]
    expect(total).toMatchObject({
      input: 370,
      output: 120,
      cacheRead: 15,
      cacheWrite: 10,
      totalTokens: 515,
      reasoning: 48,
      cacheWrite1h: 6,
    })
    for (const counter of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
      expect(total.cost[counter]).toBeCloseTo(reported.cost[counter] + other.cost[counter], 12)
    expect(fixture.calls).toHaveLength(2)
  },
)

it('accounts a received stale default response even when newer transcript input rejects the assessment', async () => {
  const fixture = await launch([{ usage: reported, held: true }])
  await fixture.submit()
  await until(() => fixture.calls.length === 1)
  await (
    await fixture.root.submit(
      {
        type: 'write',
        entry: {
          kind: 'pi.user',
          model: [
            { role: 'user', content: 'New context invalidates the result.', timestamp: Date.now() },
          ],
        },
      },
      context,
    )
  ).wait(context)
  fixture.calls[0].release()
  await until(async () => (await fixture.read())?.assessmentStatus === 'error')
  expect((await fixture.read())?.assessment).toBeUndefined()
  expect((await fixture.ledger())?.models[key]).toEqual(reported)
})

it('settles usage atomically and reuses a saved response across interruption, replay and reopen', async () => {
  const fixture = await launch([{ usage: reported, interruptAfterReceipt: true }, { usage: other }])
  await fixture.submit()
  await until(() => fixture.interruption !== undefined)
  expect(
    fixture.commits
      .filter((publication) =>
        publication.changes.some(
          (change) => change.type === 'task' && change.value.memos?.response !== undefined,
        ),
      )
      .every(
        (publication) =>
          !publication.changes.some(
            (change) =>
              change.type === 'document' && change.record.kind === UsageDoc.definition.kind,
          ),
      ),
  ).toBe(true)
  await fixture.reopen()
  await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
  expect((await fixture.ledger())?.models[key]).toEqual(reported)
  expect(fixture.calls).toHaveLength(1)
  expect(
    fixture.commits.some(
      (publication) =>
        publication.changes.some(
          (change) =>
            change.type === 'task' &&
            change.value.kind === 'conversations.summary' &&
            change.value.state.status === 'terminal',
        ) &&
        publication.changes.some(
          (change) => change.type === 'document' && change.record.kind === UsageDoc.definition.kind,
        ),
    ),
  ).toBe(true)
  await fixture.replayYield()
  await fixture.reopen()
  expect((await fixture.ledger())?.models[key]).toEqual(reported)
  expect(fixture.calls).toHaveLength(1)
  await fixture.finish()
  expect(fixture.calls).toHaveLength(2)
  expect((await fixture.ledger())?.models[key].totalTokens).toBe(515)
})

it.each(['stale', 'abort'] as const)(
  'settles saved usage once when reopen takes the %s exit instead of applying the reply',
  async (reason) => {
    const fixture = await launch([{ usage: reported, interruptAfterReceipt: true }])
    await fixture.submit()
    await until(() => fixture.interruption !== undefined)
    await fixture.reopen(reason)
    await until(async () => !!(await fixture.ledger())?.models[key])
    expect((await fixture.ledger())?.models[key]).toEqual(reported)
    expect((await fixture.read())?.assessmentStatus).toBe('error')
    expect((await fixture.read())?.assessment).toBeUndefined()
    expect(fixture.calls).toHaveLength(1)
    await fixture.reopen()
    expect((await fixture.ledger())?.models[key]).toEqual(reported)
    expect(fixture.calls).toHaveLength(1)
  },
)

it.each([
  { name: 'unreported usage', expected: undefined },
  {
    name: 'a thrown request without a response',
    throws: true,
    expected: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
])('does not estimate $name', async (plan) => {
  const fixture = await launch([plan])
  await fixture.finish()
  const ledger = (await fixture.ledger())!
  // Models turns a thrown setup error into a zero-usage error response; do not invent positive usage.
  expect(ledger.models[key]).toEqual(plan.expected)
  expect(ledger.models['faux/faux-1'].totalTokens).toBeGreaterThan(0)
})
