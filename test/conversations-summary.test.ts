import { mkdir, writeFile } from 'node:fs/promises'
import { awaitWithContext } from '@earendil-works/chord/context'
import { Subagents } from '../extensions/subagents/server.ts'
import { join, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { Models, JsonObject } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, ToolRegistration } from '@earendil-works/pi-durable'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask, defineTool, LiveDoc } from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Overview } from '../extensions/conversations/overview.ts'
import {
  generateSummary,
  Summaries,
  summaryBehavior,
  scheduleSpawnSummary,
  TitleChanged,
} from '../extensions/conversations/summary.ts'
import { fauxServer, post, prepareFauxServer, temp, until } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
async function launch(subagents = false) {
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
          scheduleSpawnSummary(
            tx,
            {
              harness: () => server.harness,
              metadata: Metadata,
              modelRuntime: server.host.modelRuntime,
              extensions: () => [
                {
                  name: 'conversations',
                  path: '',
                  source: 'builtin',
                  layer: 'default',
                  actions: [],
                  enabled: true,
                  facets: { server: true, web: false },
                  server: {
                    tools: [],
                    sections: [],
                    hooks: 1,
                    docs: ['ultimate.conversation-summaries'],
                  },
                },
              ],
            },
            server.root.id,
            { answer, agent: 'scout', task: 'Continue the plan.' },
          ),
        context,
      ),
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
              return { content: [{ type: 'text', text: 'Released' }] }
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
      expect(state?.status).toBe('error')
    } finally {
      release()
    }
    await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
    expect((await fixture.read())?.status).toBe('error')
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
          execute: async () => ({ content: [{ type: 'text', text: 'SECRET_TOOL_OUTPUT' }] }),
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
  await fixture.exchange()
  expect((await fixture.read())?.status).toBe('error')
  expect((await fixture.read())?.summary).toBeUndefined()
  expect(await fixture.titleChanges()).toEqual([])
  for (let count = 2; count <= 4; count++) await fixture.exchange()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(fixture.generated).toHaveBeenCalledTimes(5)
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
  for (const value of ['blocked', 'unfinished', ['done'], null]) {
    output = { assessment: value, activity: 'Some work was discussed.' }
    await expect(
      generateSummary(models, 'Reply', new AbortController().signal, false),
    ).rejects.toThrow('Invalid assessment')
  }
})
