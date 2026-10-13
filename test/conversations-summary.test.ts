import { mkdir, writeFile } from 'node:fs/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Subagents } from '../extensions/subagents/server.ts'
import { join, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { Models, JsonObject } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, TaskId, ToolRegistration } from '@earendil-works/pi-durable'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Overview } from '../extensions/conversations/overview.ts'
import {
  generateSummary,
  Summaries,
  summaryBehavior,
  requestSummary,
  IntentSummarized,
  TitleChanged,
  AssessmentAccepted,
  SummaryDiscarded,
} from '../extensions/conversations/summary.ts'
import { fauxServer, post, prepareFauxServer, temp, until } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
async function launch(subagents = false, initialIntent = false) {
  const home = await temp('ultimate-summary-')
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  if (subagents) {
    await mkdir(join(projectRoot, '.ultimate/agents'), { recursive: true })
    await writeFile(
      join(projectRoot, '.ultimate/settings.json'),
      JSON.stringify({ extensions: { enable: ['subagents'] } }),
    )
    await writeFile(
      join(projectRoot, '.ultimate/agents/summary-child.md'),
      '---\nname: summary-child\ndescription: Summary test child\ntools: [summary_hold]\n---\nWait for release.\n',
    )
  }
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  }
  let server = await fauxServer(options)
  servers.push(server)
  if (!initialIntent)
    await server.harness.commit(
      (tx) =>
        tx.appendEntry(server.root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Established context', timestamp: 1 }],
        }),
      context,
    )
  const generated = vi.fn<typeof generateSummary>(async () => ({
    assessment: 'done',
    activity: 'Added concise summaries to the sidebar.',
    title: 'Improve the conversation sidebar',
    summary: 'Added concise summaries to the sidebar.',
  }))
  const install = (registry = server.host.registry) => {
    const existing = registry.snapshot().extension('conversations')!
    registry.install(
      defineExtension({
        ...existing,
        ...summaryBehavior(
          {
            harness: () => server.harness,
            metadata: Metadata,
            modelRuntime: {
              getAvailableSnapshot: () =>
                server.host.modelRuntime
                  .getModels()
                  .filter((model) => model.provider === 'openai' && model.id === 'gpt-6-luna'),
            },
          },
          generated,
        ),
      }),
    )
  }
  install()
  const read = () => server.harness.snapshot(Summaries, server.root.id, context)
  const exchange = async () => {
    const before = (await read())?.lastAnswer
    server.host.faux!.setResponses([fauxAssistantMessage('A finished answer.')])
    const submission = await server.root.submit(
      { type: 'input', content: 'Improve this conversation.' },
      context,
    )
    expect((await submission.wait(context)).status).toBe('done')
    await until(async () => (await read())?.lastAnswer !== before && !(await read())?.pending)
  }
  return {
    get server() {
      return server
    },
    generated,
    spawn: (answer: EntryId) =>
      server.harness.commit(
        (tx) =>
          requestSummary(
            tx,
            {
              harness: () => server.harness,
              metadata: Metadata,
              modelRuntime: server.host.modelRuntime,
            },
            server.root.id,
            { reason: 'spawn', answer, agent: 'scout', task: 'Continue the plan.' },
          ),
        context,
      ),
    entries: async (id = server.root.id) =>
      (await server.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 200), context))
        .items,
    titleChanges: async (id = server.root.id) =>
      (
        await server.harness.commit((tx) => tx.scanEntries({ conversationId: id }, 100), context)
      ).items.filter((entry) => TitleChanged.is(entry)),
    install,
    read,
    exchange,
    action: (name: string, title?: string) =>
      post(server, `/api/extensions/conversations/actions/${name}`, {
        args: { id: server.root.id, ...(title !== undefined && { title }) },
      }),
    reopen: async () => {
      await server.close()
      servers.splice(servers.indexOf(server), 1)
      const prepared = await prepareFauxServer(options)
      install(prepared.host.registry)
      server = { ...prepared, ...(await prepared.go()) }
      const close = server.close.bind(server)
      server.close = async () => {
        await server.vite.watcher.close()
        await close()
      }
      servers.push(server)
    },
  }
}

it.each([false, true])(
  'refreshes during an actual subagent start, background=%s, while parent and child are busy',
  async (background) => {
    const fixture = await launch(true)
    const { server } = fixture
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const holding = new Set<number>()
    let replayed = false
    const interrupted = new Error('Replay after committed creation, before result receipt')
    server.host.registry.install(
      defineExtension({
        name: 'spawn-replay',
        wraps: [
          {
            tool: 'subagent',
            wrap: (tool: ToolRegistration): ToolRegistration => ({
              ...tool,
              execute: async (args, api, toolContext) => {
                try {
                  return await tool.execute(
                    args,
                    {
                      ...api,
                      details: async (value, caller) => {
                        if (!replayed) {
                          replayed = true
                          throw interrupted
                        }
                        return api.details(value, caller)
                      },
                    },
                    toolContext,
                  )
                } catch (error) {
                  if (error !== interrupted) throw error
                  return tool.execute(args, api, toolContext)
                }
              },
            }),
          },
        ],
      }),
    )
    server.host.registry.install(
      defineExtension({
        name: 'summary-hold',
        tools: [
          defineTool({
            name: 'summary_hold',
            description: 'Hold work until released',
            parameters: Type.Object({}),
            execute: async (_args, api, toolContext) => {
              holding.add(api.conversationId)
              await awaitWithContext(gate, toolContext)
              return { output: [{ type: 'text', text: 'Released' }] }
            },
          }),
        ],
      }),
    )
    server.host.faux!.setResponses([
      fauxAssistantMessage(
        [
          { type: 'text', text: 'Plan: delegate the sidebar implementation, then verify it.' },
          fauxToolCall('subagent', {
            action: 'start',
            agent: 'summary-child',
            task: 'Implement the sidebar plan.',
            background,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxToolCall('summary_hold', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('summary_hold', {})], { stopReason: 'toolUse' }),
    ])
    const submission = await server.root.submit(
      { type: 'input', content: 'Plan and implement the sidebar.' },
      context,
    )
    try {
      await until(async () => (await fixture.read())?.status === 'ready')
      const agents = Object.values(
        (await server.harness.snapshot(Subagents, server.root.id, context))!.agents,
      )
      expect(agents).toHaveLength(1)
      expect(replayed).toBe(true)
      const child = agents[0].conversationId
      await until(() => holding.has(child))
      expect((await server.harness.snapshot(LiveDoc, child, context))?.run).toBeDefined()
      expect((await server.harness.snapshot(LiveDoc, server.root.id, context))?.run).toBeDefined()
      expect((await submission.status(context)).status).toBe('placed')
      expect((await fixture.read())?.exchanges).toBe(0)
      expect((await fixture.read())?.assessment).toBeUndefined()
      expect((await fixture.read())?.activity).toBeUndefined()
      expect((await fixture.read())?.summaryOwed).toBeUndefined()
      expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
      expect((await server.harness.snapshot(Metadata, server.root.id, context))?.title).toBe(
        'Improve the conversation sidebar',
      )
      expect(fixture.generated).toHaveBeenCalledTimes(1)
      expect(fixture.generated.mock.calls[0][1]).toContain(
        'Plan: delegate the sidebar implementation',
      )
      expect(fixture.generated.mock.calls[0][1]).toContain('Implement the sidebar plan.')
      expect(fixture.generated.mock.calls[0][5]).toBe('spawn')
    } finally {
      server.host.faux!.appendResponses(
        Array.from({ length: 6 }, () => fauxAssistantMessage('Completed delegated work.')),
      )
      release()
    }
    await submission.wait(context)
    await server.harness.waitForIdle(context)
    await until(
      async () => ((await fixture.read())?.exchanges ?? 0) >= 1 && !(await fixture.read())?.pending,
    )
    expect(fixture.generated.mock.calls.filter((call) => call[5] === 'spawn')).toHaveLength(1)
    expect(
      fixture.generated.mock.calls.some((call) => call[5] === 'reply' && call[3] === true),
    ).toBe(true)
    const child = Object.values(
      (await server.harness.snapshot(Subagents, server.root.id, context))!.agents,
    )[0].conversationId
    const actions: JsonObject[] = [
      { action: 'start', agent: 'missing-agent', task: 'Must fail' },
      { action: 'message', id: child, text: 'Follow up', background: true },
      { action: 'wait', id: child },
    ]
    for (const args of actions) {
      server.host.faux!.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', args)], { stopReason: 'toolUse' }),
        ...Array.from({ length: 6 }, () => fauxAssistantMessage('Final reply.')),
      ])
      await (
        await server.root.submit({ type: 'input', content: 'Exercise a non-spawn action' }, context)
      ).wait(context)
      await server.harness.waitForIdle(context)
      await until(async () =>
        Object.values((await server.harness.inspect(context)).tasks).every(
          (task) => task.record.kind !== 'conversations.summary',
        ),
      )
      expect(fixture.generated.mock.calls.filter((call) => call[5] === 'spawn')).toHaveLength(1)
    }
  },
  60000,
)

it.each(['rename', 'reset', 'newer'] as const)(
  'protects a held spawn result after %s',
  async (change) => {
    const fixture = await launch()
    await fixture.exchange()
    const answer = (await fixture.read())!.lastAnswer!
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    fixture.generated.mockImplementationOnce(async () => {
      await gate
      return {
        assessment: 'needs_input',
        activity: 'Must not publish',
        title: 'Old spawn title',
        summary: 'Old spawn summary',
      }
    })
    await fixture.spawn(answer)
    await until(() => fixture.generated.mock.calls.length === 2)
    try {
      if (change === 'rename') await fixture.action('rename', 'Manual title')
      else if (change === 'reset') await fixture.action('reset')
      else await fixture.exchange()
    } finally {
      release()
    }
    await until(
      async () => Object.values((await fixture.server.harness.inspect(context)).tasks).length === 0,
    )
    await until(async () => !(await fixture.read())?.pending)
    const state = await fixture.read()
    const title = (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))
      ?.title
    expect(state?.activity).not.toBe('Must not publish')
    expect(title).toBe(change === 'rename' ? 'Manual title' : 'Improve the conversation sidebar')
    expect(state?.summary).toBe(
      {
        rename: 'Old spawn summary',
        reset: undefined,
        newer: 'Added concise summaries to the sidebar.',
      }[change],
    )
    expect(state?.exchanges).toBe({ rename: 1, reset: 0, newer: 2 }[change])
  },
  60000,
)

it.each([2, 3])(
  'settles a held spawn superseded by assessment-only exchange %s without changing cadence',
  async (exchange) => {
    const fixture = await launch()
    for (let count = 1; count < exchange; count++) await fixture.exchange()
    const before = (await fixture.read())!
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    fixture.generated.mockImplementationOnce(async () => {
      await gate
      return { assessment: 'done', activity: 'Old spawn', title: 'Old spawn', summary: 'Old spawn' }
    })
    await fixture.spawn(before.lastAnswer!)
    await until(() => fixture.generated.mock.calls.length === exchange)
    expect((await fixture.read())?.status).toBe('pending')
    try {
      await fixture.exchange()
      const state = await fixture.read()
      expect(state?.pending).toBeUndefined()
      expect(state?.assessmentStatus).toBe('ready')
      expect(state?.exchanges).toBe(exchange)
      expect(state?.summary).toBe(before.summary)
      expect(state?.summaryOwed).toBeUndefined()
      expect(fixture.generated.mock.calls.at(-1)![3]).toBe(false)
      expect(state?.status).toBe('stale')
    } finally {
      release()
    }
    await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
    expect((await fixture.read())?.status).toBe('stale')
    const discarded = (await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))
    expect(discarded.map((entry) => entry.data)).toEqual([
      { reason: 'stale', cause: 'superseded', at: expect.any(Number) },
    ])
    const spawnTask = await fixture.server.harness.getTask(discarded[0].byTaskId!, context)
    expect(spawnTask?.kind).toBe('conversations.summary')
    expect(spawnTask?.input).toMatchObject({ spawn: { answer: before.lastAnswer } })
    expect((await fixture.read())?.summary).toBe(before.summary)
    for (let count = exchange + 1; count <= 4; count++) await fixture.exchange()
    expect((await fixture.read())?.exchanges).toBe(4)
    expect((await fixture.read())?.status).toBe('ready')
    expect(
      fixture.generated.mock.calls.filter((call) => call[5] === 'reply').map((call) => call[3]),
    ).toEqual([true, false, false, true])
  },
  60000,
)

it('summarizes the first, fourth and seventh completed exchanges, not tools, streams or idle time; persists across reopen', async () => {
  const fixture = await launch()
  const { server } = fixture
  let generation = 0
  fixture.generated.mockImplementation(async () => ({
    assessment: 'done',
    activity: 'Added concise summaries to the sidebar.',
    title: 'Improve the conversation sidebar',
    summary: `Sidebar summary ${++generation}.`,
  }))
  server.host.registry.install(
    defineExtension({
      name: 'summary-tools',
      tools: [
        defineTool({
          name: 'summary_probe',
          description: 'Probe',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT' }] }),
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('summary_probe', {}), { type: 'thinking', thinking: 'SECRET_THINKING' }],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Final response.'),
  ])
  const submission = await server.root.submit(
    { type: 'input', content: 'Work on the sidebar.' },
    context,
  )
  expect((await submission.wait(context)).status).toBe('done')
  await until(() => fixture.generated.mock.calls.length === 1)
  await until(async () => (await fixture.read())?.status === 'ready')
  expect((await fixture.read())?.exchanges).toBe(1)
  expect((await fixture.read())?.summary).toBe('Sidebar summary 1.')
  expect(fixture.generated.mock.calls[0][1]).not.toMatch(/SECRET_TOOL_OUTPUT|SECRET_THINKING/)
  for (let count = 2; count <= 4; count++) {
    await fixture.exchange()
    await until(async () => (await fixture.read())?.exchanges === count)
    await fixture.server.harness.waitForIdle(context)
    expect((await fixture.read())?.summary).toBe(`Sidebar summary ${count === 4 ? 4 : 1}.`)
  }
  expect((await server.harness.snapshot(Metadata, server.root.id, context))?.title).toBe(
    'Improve the conversation sidebar',
  )
  const changes = await fixture.titleChanges()
  expect(changes).toHaveLength(1)
  expect(changes[0].data).toEqual({
    title: 'Improve the conversation sidebar',
    at: expect.any(Number),
  })
  expect(changes[0].model).toBeUndefined()
  const view = await server.root.context(context)
  expect(view.contributions[view.entries.findIndex((entry) => entry.id === changes[0].id)]).toEqual(
    [],
  )
  expect(JSON.stringify(view.messages)).not.toContain('Improve the conversation sidebar')
  await fixture.reopen()
  expect(await fixture.titleChanges()).toEqual(changes)
  expect((await fixture.read())?.summary).toBe('Sidebar summary 4.')
  expect((await fixture.read())?.exchanges).toBe(4)
  for (let count = 5; count <= 7; count++) {
    await fixture.exchange()
    await until(async () => (await fixture.read())?.exchanges === count)
    await fixture.server.harness.waitForIdle(context)
    expect((await fixture.read())?.summary).toBe(`Sidebar summary ${count === 7 ? 7 : 4}.`)
  }
  await fixture.server.harness.waitForIdle(context)
  expect(await fixture.titleChanges()).toEqual(changes)
}, 60000)

it('logs each accepted title change once, but not a manual rename to the generated title', async () => {
  const fixture = await launch()
  const started = Date.now()
  await fixture.exchange()
  fixture.generated.mockResolvedValue({
    assessment: 'done',
    activity: 'Refined the sidebar.',
    title: 'Refine the sidebar',
    summary: 'Refined the sidebar.',
  })
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  const changes = await fixture.titleChanges()
  expect(changes.map((entry) => entry.data)).toEqual([
    { title: 'Refine the sidebar', at: expect.any(Number) },
    { title: 'Improve the conversation sidebar', at: expect.any(Number) },
  ])
  for (const entry of changes) {
    expect(entry.data.at).toBeGreaterThanOrEqual(started)
    expect(entry.data.at).toBeLessThanOrEqual(Date.now())
    expect(entry.model).toBeUndefined()
    expect(entry.byTaskId).toBeDefined()
  }
  await fixture.action('rename', 'Refine the sidebar')
  fixture.generated.mockResolvedValue({
    assessment: 'done',
    activity: 'Done.',
    title: 'Not accepted',
    summary: 'Done.',
  })
  for (let count = 5; count <= 7; count++) await fixture.exchange()
  expect(await fixture.titleChanges()).toEqual(changes)
  await fixture.reopen()
  expect(await fixture.titleChanges()).toEqual(changes)
}, 60000)

it('keeps an explicit API title even when it equals the first input', async () => {
  const fixture = await launch()
  const text = 'This preexisting title equals the prompt.'
  const created = await post(fixture.server, '/api/conversations', { title: text })
  expect(created.status).toBe(201)
  const id = created.data.id as ConversationId
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
  expect((await post(fixture.server, `/api/conversations/${id}/submit`, { text })).status).toBe(202)
  await until(
    async () => (await fixture.server.harness.snapshot(Summaries, id, context))?.status === 'ready',
  )
  expect(await fixture.server.harness.snapshot(Metadata, id, context)).toEqual({ title: text })
  await fixture.reopen()
  expect(await fixture.server.harness.snapshot(Metadata, id, context)).toEqual({ title: text })
  expect(await fixture.titleChanges(id)).toEqual([])
}, 60000)

it('protects preexisting and in-flight manual titles, and blank rename restores automatic naming', async () => {
  const fixture = await launch()
  await fixture.server.harness.commit(async (tx) => {
    ;(await tx.doc(Metadata, fixture.server.root.id)).title = 'Existing title'
  }, context)
  await fixture.exchange()
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('Existing title')
  await fixture.action('rename', '')
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  for (let count = 2; count <= 3; count++) await fixture.exchange()
  fixture.generated.mockImplementationOnce(async () => {
    await gate
    return {
      assessment: 'done' as const,
      activity: 'Implemented the requested sidebar changes.',
      title: 'An automatically updated title',
      summary: 'Updated summary.',
    }
  })
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Fourth answer.')])
  const fourth = await fixture.server.root.submit(
    { type: 'input', content: 'Fourth input' },
    context,
  )
  await fourth.wait(context)
  await until(async () => (await fixture.read())?.status === 'pending')
  // Background work does not keep the conversation busy or block its idle wait.
  await fixture.server.root.waitForIdle(context)
  await fixture.action('rename', 'My deliberate title')
  release()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('My deliberate title')
  expect((await fixture.read())?.summary).toBe('Updated summary.')
  expect(await fixture.titleChanges()).toEqual([])
  await fixture.action('rename', '')
  for (let count = 5; count <= 7; count++) await fixture.exchange()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
  expect(await fixture.titleChanges()).toHaveLength(1)
}, 60000)

it('clears summary and cadence on reset, drops stale completion and isolates provider errors', async () => {
  const fixture = await launch()
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async () => {
    await gate
    return {
      assessment: 'done' as const,
      activity: 'Implemented the requested sidebar changes.',
      title: 'A stale generated title',
      summary: 'Stale summary.',
    }
  })
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
  const first = await fixture.server.root.submit({ type: 'input', content: 'Old context' }, context)
  expect((await first.wait(context)).status).toBe('done')
  await until(async () => (await fixture.read())?.status === 'pending')
  expect((await fixture.action('reset')).status).toBe(200)
  expect((await fixture.read())?.exchanges).toBe(0)
  expect((await fixture.read())?.summary).toBeUndefined()
  release()
  await until(
    async () => Object.values((await fixture.server.harness.inspect(context)).tasks).length === 0,
  )
  expect((await fixture.read())?.summary).toBeUndefined()
  fixture.generated.mockRejectedValueOnce(new Error('Provider offline'))
  fixture.generated.mockRejectedValueOnce(new Error('Provider offline'))
  await fixture.exchange()
  expect((await fixture.read())?.status).toBe('error')
  expect((await fixture.read())?.assessmentStatus).toBe('error')
  expect((await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))[0]?.data).toEqual({
    reason: 'error',
    cause: 'Provider offline',
    at: expect.any(Number),
  })
  expect((await fixture.read())?.summary).toBeUndefined()
  expect(await fixture.titleChanges()).toEqual([])
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(fixture.generated).toHaveBeenCalledTimes(6)
}, 60000)

it('assesses owned children without renaming them, excludes ownerless forks, and does not backfill', async () => {
  const fixture = await launch()
  const root = fixture.server.root
  await fixture.server.harness.commit(
    (tx) =>
      tx.appendEntry(root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Historical input', timestamp: 1 }],
      }),
    context,
  )
  expect(fixture.generated).not.toHaveBeenCalled()
  const anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'summary-anchor',
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
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller)
    },
  })
  const child = await fixture.server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: root.id,
      background: true,
    })
    const created = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
    Object.assign(await tx.doc(Metadata, created.id), {
      title: 'Scout the task boundaries',
      label: 'scout',
    })
    return created
  }, context)
  const entry = (await root.context(context)).entries[0]
  const fork = await root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  for (const id of [child.id, fork.id]) {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Child answer.')])
    const conversation = (await fixture.server.harness.conversation(id, context))!
    expect(
      (
        await (
          await conversation.submit({ type: 'input', content: 'Child input' }, context)
        ).wait(context)
      ).status,
    ).toBe('done')
  }
  await until(
    async () =>
      (await fixture.server.harness.snapshot(Summaries, child.id, context))?.assessmentStatus ===
      'ready',
  )
  expect((await fixture.server.harness.snapshot(Summaries, child.id, context))?.exchanges).toBe(1)
  expect(
    (await fixture.server.harness.snapshot(Summaries, child.id, context))?.summary,
  ).toBeUndefined()
  expect(await fixture.server.harness.snapshot(Metadata, child.id, context)).toEqual({
    title: 'Scout the task boundaries',
    label: 'scout',
  })
  expect((await fixture.server.harness.snapshot(Summaries, fork.id, context))?.exchanges ?? 0).toBe(
    0,
  )
  expect(fixture.generated).toHaveBeenCalledTimes(1)
  expect(await fixture.titleChanges(child.id)).toEqual([])
  expect(await fixture.titleChanges(fork.id)).toEqual([])
  await fixture.exchange()
  expect(fixture.generated).toHaveBeenCalledTimes(2)
  expect(fixture.generated.mock.calls.some((call) => call[5] === 'intent')).toBe(false)
}, 60000)

it('rejects an older response after a newer scheduled summary has completed', async () => {
  const fixture = await launch()
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async () => {
    await gate
    return {
      assessment: 'done' as const,
      activity: 'Implemented the requested sidebar changes.',
      title: 'An older stale title',
      summary: 'Older stale summary.',
    }
  })
  for (let count = 1; count <= 4; count++) {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    await (
      await fixture.server.root.submit({ type: 'input', content: `Exchange ${count}` }, context)
    ).wait(context)
    await until(async () => (await fixture.read())?.exchanges === count)
    if (count === 1) await until(() => fixture.generated.mock.calls.length === 1)
    else await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
  }
  await until(async () => (await fixture.read())?.status === 'ready')
  release()
  await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
  expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
  expect(await fixture.titleChanges()).toHaveLength(1)
}, 60000)

it.each(['reply', 'spawn'] as const)(
  'resumes pending %s generation after shutdown without a stuck checkpoint',
  async (mode) => {
    const fixture = await launch()
    if (mode === 'spawn') await fixture.exchange()
    fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
      await new Promise((_done, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }),
      )
      throw new Error('Unreachable')
    })
    if (mode === 'spawn') await fixture.spawn((await fixture.read())!.lastAnswer!)
    else {
      fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
      await (
        await fixture.server.root.submit({ type: 'input', content: 'Summarize this' }, context)
      ).wait(context)
    }
    await until(() => fixture.generated.mock.calls.length === (mode === 'spawn' ? 2 : 1))
    await fixture.reopen()
    await until(async () => (await fixture.read())?.status === 'ready')
    expect((await fixture.read())?.exchanges).toBe(1)
    expect(fixture.generated).toHaveBeenCalledTimes(mode === 'spawn' ? 3 : 2)
    const changes = await fixture.titleChanges()
    expect(changes).toHaveLength(1)
    await fixture.reopen()
    expect(await fixture.titleChanges()).toEqual(changes)
  },
  60000,
)

it.each(['none', 'legacy'])(
  'skips summaries and assessments when current OpenAI Luna is unavailable (%s)',
  async (available) => {
    const fixture = await launch()
    const server = fixture.server
    const existing = server.host.registry.snapshot().extension('conversations')!
    const models =
      available === 'none'
        ? []
        : server.host.modelRuntime
            .getModels()
            .filter((model) => model.provider === 'openai-codex' && model.id === 'gpt-6-luna')
    expect(models).toHaveLength(available === 'none' ? 0 : 1)
    server.host.registry.install(
      defineExtension({
        ...existing,
        ...summaryBehavior(
          {
            harness: () => server.harness,
            metadata: Metadata,
            modelRuntime: { getAvailableSnapshot: () => models },
          },
          fixture.generated,
        ),
      }),
    )
    server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    await (await server.root.submit({ type: 'input', content: 'Work' }, context)).wait(context)
    await server.harness.waitForIdle(context)
    expect(fixture.generated).not.toHaveBeenCalled()
    expect(await fixture.titleChanges()).toEqual([])
    expect((await server.harness.inspect(context)).tasks).toHaveLength(0)
    expect((await fixture.read())?.status).toBeUndefined()
    expect((await fixture.read())?.assessmentStatus).toBeUndefined()
    expect((await fixture.read())?.exchanges ?? 0).toBe(0)
    expect(
      (await server.harness.snapshot(Overview, server.root.id, context))?.conversations[
        server.root.id
      ]?.assessmentStatus,
    ).toBeUndefined()
  },
)

it('validates assessment-only JSON and rejects unapproved or malformed outcome states', async () => {
  let output: unknown = {
    assessment: 'needs_input',
    activity: 'Asked the coordinator to choose a deployment target.',
  }
  const stream = vi.fn<Models['streamSimple']>(() => {
    const events = new AssistantMessageEventStream()
    const answer = fauxAssistantMessage(JSON.stringify(output))
    events.push({ type: 'done', reason: 'stop', message: answer })
    events.end()
    return events
  })
  const getModel = vi.fn<(provider: string, id: string) => { provider: string; id: string }>(
    () => ({ provider: 'openai', id: 'gpt-6-luna' }),
  )
  const models = {
    getModel,
    streamSimple: stream,
  } as unknown as Models
  expect(
    await generateSummary(models, 'Untrusted reply text', new AbortController().signal, false),
  ).toEqual(output)
  expect(getModel).toHaveBeenCalledWith('openai', 'gpt-6-luna')
  output = { title: 'Delegate the sidebar', summary: 'Planning has moved to implementation.' }
  expect(
    await generateSummary(
      models,
      'Delegation',
      new AbortController().signal,
      true,
      undefined,
      'spawn',
    ),
  ).toEqual({
    ...(output as object),
    assessment: 'neutral',
    activity: '',
  })
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('work now starting')
  expect(stream.mock.calls.at(-1)![1].systemPrompt).not.toContain('Assess the latest final reply')
  await generateSummary(
    models,
    'Initial input',
    new AbortController().signal,
    true,
    undefined,
    'intent',
  )
  expect(stream.mock.calls.at(-1)![1].systemPrompt).toContain('initial intent')
  for (const value of ['blocked', 'unfinished', ['done'], null]) {
    output = { assessment: value, activity: 'Some work was discussed.' }
    await expect(
      generateSummary(models, 'Reply', new AbortController().signal, false),
    ).rejects.toThrow('Invalid assessment')
  }
})

it('publishes initial intent while the main model request is blocked, once across retries and reopen', async () => {
  const fixture = await launch(false, true)
  const { server } = fixture
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  server.host.registry.install(
    defineExtension({
      ...server.host.registry.snapshot().extension('conversations')!,
      tools: [
        defineTool({
          name: 'intent_probe',
          description: 'Probe another model round',
          parameters: Type.Object({}),
          execute: async () => ({ output: [{ type: 'text', text: 'Continue' }] }),
        }),
      ],
      hooks: [
        ...server.host.registry.snapshot().extension('conversations')!.hooks!,
        hook(GenerationTask, {
          beforeRequest: async () => {
            await gate
            return undefined
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('intent_probe', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Final answer.'),
  ])
  const submission = await server.root.submit(
    { type: 'input', content: 'Build a sidebar.' },
    context,
  )
  const intents = () =>
    fixture.server.harness.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId: fixture.server.root.id }, 100)).items.filter(
          (entry) => IntentSummarized.is(entry),
        ),
      context,
    )
  try {
    await until(async () => (await intents()).length === 1)
    expect((await submission.status(context)).status).toBe('placed')
    expect((await fixture.read())?.exchanges).toBe(0)
    expect((await fixture.read())?.assessment).toBeUndefined()
    expect(fixture.generated.mock.calls.map((call) => call[5])).toEqual(['intent'])
    expect(fixture.generated.mock.calls[0][1]).toContain('Build a sidebar.')
    const entries = await intents()
    expect(entries[0].data).toEqual({
      summary: 'Added concise summaries to the sidebar.',
      at: expect.any(Number),
    })
    expect(entries[0].model).toBeUndefined()
    const view = await server.root.context(context)
    expect(JSON.stringify(view.messages)).not.toContain('Added concise summaries')
    expect(
      view.contributions[view.entries.findIndex((entry) => entry.id === entries[0].id)],
    ).toEqual([])
  } finally {
    release()
  }
  await submission.wait(context)
  await until(
    async () => (await fixture.read())?.exchanges === 1 && !(await fixture.read())?.pending,
  )
  const entries = await intents()
  await fixture.exchange()
  expect(await intents()).toEqual(entries)
  await fixture.reopen()
  expect(await intents()).toEqual(entries)
  await fixture.action('reset')
  await fixture.exchange()
  expect(fixture.generated.mock.calls.filter((call) => call[5] === 'intent')).toHaveLength(2)
  expect((await fixture.read())?.exchanges).toBe(1)
}, 60000)

it.each(['newer', 'reset', 'spawn'] as const)(
  'rejects a held initial intent after %s',
  async (change) => {
    const fixture = await launch(false, true)
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    fixture.generated.mockImplementationOnce(async () => {
      await gate
      return { assessment: 'neutral', activity: '', title: 'Stale intent', summary: 'Stale intent' }
    })
    // Hold the main request too, so the intent starts before any reply can supersede it.
    let resume!: () => void
    const main = new Promise<void>((done) => {
      resume = done
    })
    fixture.server.host.registry.install(
      defineExtension({
        ...fixture.server.host.registry.snapshot().extension('conversations')!,
        hooks: [
          ...fixture.server.host.registry.snapshot().extension('conversations')!.hooks!,
          hook(GenerationTask, {
            beforeRequest: async () => {
              await main
              return undefined
            },
          }),
        ],
      }),
    )
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Final reply.')])
    const submitted = await fixture.server.root.submit(
      { type: 'input', content: 'Initial goal' },
      context,
    )
    await until(() => fixture.generated.mock.calls.length === 1)
    try {
      if (change === 'newer')
        await fixture.server.root.submit({ type: 'input', content: 'Changed goal' }, context)
      else if (change === 'spawn') {
        const entries = await fixture.server.root.context(context)
        await fixture.spawn(entries.entries.find((entry) => entry.kind === 'pi.user')!.id)
      } else {
        // A reset is only allowed while idle. Let the main reply supersede the intent first.
        resume()
        await submitted.wait(context)
        await until(async () => (await fixture.read())?.exchanges === 1)
        await fixture.action('reset')
      }
      release()
      await until(
        async () =>
          Object.values((await fixture.server.harness.inspect(context)).tasks).filter(
            (task) => task.record.kind === 'conversations.summary',
          ).length === 0,
      )
      const entries = await fixture.server.harness.commit(
        (tx) => tx.scanEntries({ conversationId: fixture.server.root.id }, 100),
        context,
      )
      expect(entries.items.filter((entry) => IntentSummarized.is(entry))).toEqual([])
      expect((await fixture.read())?.summary).not.toBe('Stale intent')
    } finally {
      release()
      resume()
      fixture.server.host.faux!.appendResponses([
        fauxAssistantMessage('Final reply.'),
        fauxAssistantMessage('Final reply.'),
      ])
    }
  },
  60000,
)

it('keeps an exchange answered across a mid-run compaction and reopen; only a reset ends it', async () => {
  const fixture = await launch()
  const { server } = fixture
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  let holding = false
  server.host.registry.install(
    defineExtension({
      name: 'compaction-hold',
      tools: [
        defineTool({
          name: 'compaction_hold',
          description: 'Hold work until released',
          parameters: Type.Object({}),
          execute: async (_args, _api, toolContext) => {
            holding = true
            await awaitWithContext(gate, toolContext)
            return { output: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('compaction_hold', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Final answer after compaction.'),
  ])
  const submission = await server.root.submit(
    { type: 'input', content: 'ORIGINAL_REQUEST: rename the sidebar.' },
    context,
  )
  await until(() => holding)
  // Compaction cuts past the user input while the run continues.
  await server.harness.commit(async (tx) => {
    const call = (await tx.scanEntries({ conversationId: server.root.id }, 10)).items.find(
      (entry) => entry.kind === 'pi.assistant',
    )!
    await tx.appendEntry(server.root.id, {
      kind: 'pi.compaction',
      head: call.id,
      data: { reason: 'manual' },
      model: [{ role: 'user', content: '<summary>\nCompacted.\n</summary>', timestamp: 2 }],
    })
  }, context)
  release()
  expect((await submission.wait(context)).status).toBe('done')
  await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
  expect(fixture.generated.mock.calls.at(-1)![1]).toMatch(
    /^Original request \(untrusted source text\):\nuser: ORIGINAL_REQUEST: rename the sidebar\./,
  )
  expect(
    (await server.root.context(context)).messages.some((message) =>
      JSON.stringify(message).includes('ORIGINAL_REQUEST'),
    ),
  ).toBe(false)
  const row = async () =>
    (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
      ?.conversations[fixture.server.root.id]
  await until(async () => (await row())?.runState === 'answered')
  expect((await row())?.assessment?.value).toBe('done')
  await fixture.reopen()
  await until(async () => (await row())?.runState === 'answered')
  expect((await row())?.assessment?.value).toBe('done')
  // A raw reset, like a tool handoff, bypasses the reset action and its revision bump.
  await fixture.server.root.reset(undefined, context)
  await until(async () => (await row())?.runState === 'idle')
  expect((await row())?.assessment).toBeUndefined()
  expect((await row())?.inputId).toBeUndefined()
}, 60000)

it('derives the same overview rows live and from a fresh open, with no summary model available', async () => {
  const fixture = await launch()
  const install = () => {
    const registry = fixture.server.host.registry
    registry.install(
      defineExtension({
        ...registry.snapshot().extension('conversations')!,
        ...summaryBehavior(
          {
            harness: () => fixture.server.harness,
            metadata: Metadata,
            modelRuntime: { getAvailableSnapshot: () => [] },
          },
          fixture.generated,
        ),
      }),
    )
  }
  install()
  let release!: () => void
  fixture.server.host.registry.install(
    defineExtension({
      name: 'overview-hold',
      tools: [
        defineTool({
          name: 'overview_hold',
          description: 'Hold work until released',
          parameters: Type.Object({}),
          execute: async (_args, _api, toolContext) => {
            await awaitWithContext(new Promise<void>((done) => (release = done)), toolContext)
            return { output: [{ type: 'text', text: 'Released' }] }
          },
        }),
      ],
    }),
  )
  const failure = fauxAssistantMessage('', {
    stopReason: 'error',
    errorMessage: 'invalid_request_error: deterministic fixture failure',
  })
  const hold = fauxAssistantMessage([fauxToolCall('overview_hold', {})], { stopReason: 'toolUse' })
  const create = async () => {
    const created = await post(fixture.server, '/api/conversations', {})
    const id = created.data.id as ConversationId
    return (await fixture.server.harness.conversation(id, context))!
  }
  const live = (id: ConversationId) =>
    fixture.server.harness.snapshot(LiveDoc, id, context).then((state) => state?.run)
  const submit = async (
    conversation: Awaited<ReturnType<typeof create>>,
    responses: ReturnType<typeof fauxAssistantMessage>[],
    during?: () => Promise<void>,
  ) => {
    fixture.server.host.faux!.setResponses(responses)
    const submission = await conversation.submit({ type: 'input', content: 'Work' }, context)
    if (during) {
      await until(async () => (await live(conversation.id)) !== undefined)
      await until(async () => (await fixture.server.harness.inspect(context)).tasks.length > 1)
      await during()
      release()
    }
    await submission.wait(context)
    await fixture.server.harness.waitForIdle(context)
  }
  const answered = await create()
  await submit(answered, [fauxAssistantMessage('Answered.')])
  const reset = await create()
  await submit(reset, [fauxAssistantMessage('Answered before reset.')])
  await reset.reset(undefined, context)
  const failed = await create()
  await submit(failed, [failure])
  const queued = await create()
  // The follow-up waits in the inbox; the failed run leaves it there.
  await submit(queued, [hold, failure], async () => {
    await queued.submit({ type: 'input', content: 'Later' }, context)
  })
  const compacted = await create()
  await submit(compacted, [hold, fauxAssistantMessage('Answered after compaction.')], () =>
    fixture.server.harness.commit(async (tx) => {
      const call = (await tx.scanEntries({ conversationId: compacted.id }, 10)).items.find(
        (entry) => entry.kind === 'pi.assistant',
      )!
      await tx.appendEntry(compacted.id, {
        kind: 'pi.compaction',
        head: call.id,
        data: { reason: 'manual' },
        model: [{ role: 'user', content: '<summary>\nCompacted.\n</summary>', timestamp: 2 }],
      })
    }, context),
  )
  const expected = {
    [answered.id]: 'answered',
    [reset.id]: 'idle',
    [failed.id]: 'error',
    [queued.id]: 'queued',
    [compacted.id]: 'answered',
  }
  const rows = async () => {
    const all = (await fixture.server.harness.snapshot(Overview, ROOT_CONVERSATION_ID, context))
      ?.conversations
    return Object.fromEntries(Object.keys(expected).map((id) => [id, all?.[id]]))
  }
  await until(async () =>
    Object.entries(await rows()).every(([id, row]) => row?.runState === expected[Number(id)]),
  )
  const built = await rows()
  expect(built[answered.id]).toEqual({
    runState: 'answered',
    inputId: expect.any(Number),
    answerId: expect.any(Number),
  })
  expect(built[reset.id]).toEqual({ runState: 'idle' })
  expect(built[failed.id]).toEqual({ runState: 'error', inputId: expect.any(Number) })
  expect(fixture.generated).not.toHaveBeenCalled()
  // The index is a projection: discard it, and a fresh open rebuilds it from the records alone.
  await fixture.server.harness.commit(async (tx) => {
    ;(await tx.doc(Overview, ROOT_CONVERSATION_ID)).conversations = {}
  }, context)
  await fixture.reopen()
  install()
  await until(async () => Object.values(await rows()).every((row) => row !== undefined))
  expect(await rows()).toEqual(built)
}, 60000)

it('records an accepted assessment as an entry traced to its summary and generation tasks', async () => {
  const fixture = await launch()
  await fixture.exchange()
  const state = (await fixture.read())!
  const entries = (await fixture.entries()).filter((entry) => AssessmentAccepted.is(entry))
  expect(entries.map((entry) => entry.data)).toEqual([
    {
      ...state.assessment,
      activity: 'Added concise summaries to the sidebar.',
      at: expect.any(Number),
    },
  ])
  expect(entries[0].model).toBeUndefined()
  const task = await fixture.server.harness.getTask(entries[0].byTaskId!, context)
  expect(task?.kind).toBe('conversations.summary')
  const generation = (task!.input as { generation: TaskId }).generation
  const run = await fixture.server.harness.getTask(generation, context)
  expect(run?.kind).toBe(GenerationTask.definition.name)
  expect(run?.state).toMatchObject({
    outcome: { status: 'completed', result: { entryId: state.assessment!.answerId } },
  })
  expect((await fixture.entries()).filter((entry) => SummaryDiscarded.is(entry))).toEqual([])
  const view = await fixture.server.root.context(context)
  expect(JSON.stringify(view.messages)).not.toContain('Added concise summaries')
}, 60000)
