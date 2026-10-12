import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { Models } from '@earendil-works/pi-ai'
import type { ConversationId, GenerationHooks } from '@earendil-works/pi-durable'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Overview } from '../extensions/conversations/overview.ts'
import { LiveDoc } from '@earendil-works/pi-durable'
import { generateSummary, Summaries, summaryBehavior } from '../extensions/conversations/summary.ts'
import { fauxServer, post, prepareFauxServer, temp, until } from './helpers.ts'

const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})
async function launch() {
  const home = await temp('ultimate-summary-')
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
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
                server.host.modelRuntime.getModels().filter((model) => model.id === 'gpt-6-luna'),
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

it('summarizes the first, fourth and seventh completed exchanges, not tools, streams or idle time; persists across reopen', async () => {
  const fixture = await launch()
  const { server } = fixture
  const previous = server.host.registry.snapshot().extension('conversations')!
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
  const generation = (await fixture.read())!.lastYield!
  // Replaying the same yield must not admit another task or count another exchange.
  await (previous.hooks![0].handlers as Partial<GenerationHooks>).onYield!(
    fauxAssistantMessage('Final response.'),
    { taskId: generation, conversationId: server.root.id } as never,
    context,
  )
  expect((await fixture.read())?.exchanges).toBe(1)
  expect(fixture.generated.mock.calls[0][1]).not.toMatch(/SECRET_TOOL_OUTPUT|SECRET_THINKING/)
  for (let count = 2; count <= 4; count++) {
    await fixture.exchange()
    await until(async () => (await fixture.read())?.exchanges === count)
  }
  await until(() => fixture.generated.mock.calls.length === 4)
  expect((await server.harness.snapshot(Metadata, server.root.id, context))?.title).toBe(
    'Improve the conversation sidebar',
  )
  await fixture.reopen()
  expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
  expect((await fixture.read())?.exchanges).toBe(4)
  for (let count = 5; count <= 7; count++) {
    await fixture.exchange()
    await until(async () => (await fixture.read())?.exchanges === count)
  }
  await until(() => fixture.generated.mock.calls.length === 7)
  await fixture.server.harness.waitForIdle(context)
  expect(fixture.generated).toHaveBeenCalledTimes(7)
  expect(fixture.generated.mock.calls.map((call) => call[3])).toEqual([
    true,
    false,
    false,
    true,
    false,
    false,
    true,
  ])
}, 60000)

it('counts distinct completions durably when an older context read finishes after a newer reply', async () => {
  const fixture = await launch()
  const behavior = summaryBehavior(
    {
      harness: () => fixture.server.harness,
      metadata: Metadata,
      modelRuntime: {
        getAvailableSnapshot: () =>
          fixture.server.host.modelRuntime.getModels().filter((model) => model.id === 'gpt-6-luna'),
      },
    },
    fixture.generated,
  )
  const definition = behavior.tasks[0].definition
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  let delayed = false
  const instrumented = new WeakSet<object>()
  const delayContext = (runtime: Parameters<typeof definition.phases.observe>[1]) => {
    if (instrumented.has(runtime)) return
    instrumented.add(runtime)
    const original = runtime.context.bind(runtime)
    vi.spyOn(runtime, 'context').mockImplementation(async (...args) => {
      if (!delayed) {
        delayed = true
        await gate
      }
      return original(...args)
    })
  }
  const wrapped = defineTask({
    ...definition,
    phases: {
      ...definition.phases,
      observe: async (task, runtime, caller) => {
        delayContext(runtime)
        await definition.phases.observe(task, runtime, caller)
      },
      prepare: async (task, runtime, caller) => {
        delayContext(runtime)
        await definition.phases.prepare(task, runtime, caller)
      },
    },
  })
  fixture.server.host.registry.install(
    defineExtension({
      ...fixture.server.host.registry.snapshot().extension('conversations')!,
      tasks: [wrapped],
    }),
  )
  let newerAnswer: number | undefined
  try {
    for (let count = 1; count <= 2; count++) {
      fixture.server.host.faux!.setResponses([fauxAssistantMessage(`Reply ${count}.`)])
      const result = await (
        await fixture.server.root.submit({ type: 'input', content: `Input ${count}` }, context)
      ).wait(context)
      expect(result.status).toBe('done')
      if (result.status === 'done' && result.type === 'input') newerAnswer = result.answer
      if (count === 1) await until(() => delayed)
    }
    // The second answer is committed while the first context read is still held.
    await until(async () => (await fixture.read())?.lastAnswer === newerAnswer)
    release()
    await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
    expect((await fixture.read())?.exchanges).toBe(2)
    expect(fixture.generated).toHaveBeenCalledTimes(1)
    const latest = (await fixture.read())!.lastAnswer
    await fixture.reopen()
    expect((await fixture.read())?.exchanges).toBe(2)
    expect((await fixture.read())?.lastAnswer).toBe(latest)
    await fixture.exchange()
    expect(fixture.generated).toHaveBeenCalledTimes(2)
    await fixture.exchange()
    expect((await fixture.read())?.exchanges).toBe(4)
    expect(fixture.generated).toHaveBeenCalledTimes(3)
  } finally {
    release()
  }
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
}, 60000)

it('preserves an equal-text manual rename during an in-flight HTTP-submit summary', async () => {
  const fixture = await launch()
  const text = 'This title equals the first prompt.'
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async () => {
    await gate
    return {
      assessment: 'done' as const,
      activity: 'Implemented the requested sidebar changes.',
      title: 'An automatically generated title',
      summary: 'Generated summary.',
    }
  })
  try {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    expect((await post(fixture.server, '/api/conversations/1/submit', { text })).status).toBe(202)
    await until(() => fixture.generated.mock.calls.length === 1)
    expect((await fixture.action('rename', text)).status).toBe(200)
    release()
    await until(async () => (await fixture.read())?.status === 'ready')
    expect(
      (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
    ).toBe(text)
    await fixture.reopen()
    for (let count = 2; count <= 4; count++) await fixture.exchange()
    expect(
      (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
    ).toBe(text)
  } finally {
    release()
  }
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
  await fixture.action('rename', '')
  for (let count = 5; count <= 7; count++) await fixture.exchange()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect(
    (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
  ).toBe('Improve the conversation sidebar')
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
  expect(fixture.generated.mock.calls[0][3]).toBe(false)
  await fixture.exchange()
  expect(fixture.generated).toHaveBeenCalledTimes(2)
}, 60000)

it('clears its own pending status when compaction makes the generated summary stale', async () => {
  const fixture = await launch()
  await fixture.server.harness.commit(async (tx) => {
    const state = await tx.doc(Summaries, fixture.server.root.id)
    state.summary = 'The last valid summary.'
  }, context)
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async () => {
    await gate
    return {
      assessment: 'done' as const,
      activity: 'Implemented the requested sidebar changes.',
      title: 'A compacted stale title',
      summary: 'Compacted stale summary.',
    }
  })
  try {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    await (
      await fixture.server.root.submit({ type: 'input', content: 'Work' }, context)
    ).wait(context)
    await until(() => fixture.generated.mock.calls.length === 1)
    await (
      await fixture.server.root.submit(
        {
          type: 'write',
          entry: {
            kind: 'pi.compaction',
            head: 'self',
            data: { reason: 'manual' },
            model: [{ role: 'user', content: 'Compacted context.', timestamp: Date.now() }],
          },
        },
        context,
      )
    ).wait(context)
    release()
    await until(async () => (await fixture.server.harness.inspect(context)).tasks.length === 0)
    expect((await fixture.read())?.pending).toBeUndefined()
    expect((await fixture.read())?.status).toBe('error')
    expect((await fixture.read())?.summary).toBe('The last valid summary.')
    expect(
      (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
    ).toBeUndefined()
  } finally {
    release()
  }
}, 60000)

it('does not clear a superseding pending request when an older compacted result completes', async () => {
  const fixture = await launch()
  let releaseOlder!: () => void
  let releaseNewer!: () => void
  const olderGate = new Promise<void>((done) => {
    releaseOlder = done
  })
  const newerGate = new Promise<void>((done) => {
    releaseNewer = done
  })
  fixture.generated.mockImplementationOnce(async () => {
    await olderGate
    return {
      assessment: 'done' as const,
      activity: 'Implemented the requested sidebar changes.',
      title: 'An older compacted title',
      summary: 'Older compacted summary.',
    }
  })
  try {
    let olderTask: number | undefined
    for (let count = 1; count <= 4; count++) {
      if (count === 4)
        fixture.generated.mockImplementationOnce(async () => {
          await newerGate
          return {
            assessment: 'done' as const,
            activity: 'Completed the newer task.',
            title: 'A newer current title',
            summary: 'Newer current summary.',
          }
        })
      fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
      await (
        await fixture.server.root.submit({ type: 'input', content: `Input ${count}` }, context)
      ).wait(context)
      await until(async () => (await fixture.read())?.exchanges === count)
      if (count === 2 || count === 3)
        await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
      if (count === 1) {
        await until(() => fixture.generated.mock.calls.length === 1)
        olderTask = (await fixture.read())?.pending
        await (
          await fixture.server.root.submit(
            {
              type: 'write',
              entry: {
                kind: 'pi.compaction',
                head: 'self',
                data: { reason: 'manual' },
                model: [{ role: 'user', content: 'Compacted context.', timestamp: Date.now() }],
              },
            },
            context,
          )
        ).wait(context)
      }
    }
    await until(() => fixture.generated.mock.calls.length === 4)
    const newerTask = (await fixture.read())?.pending
    const previousSummary = (await fixture.read())?.summary
    expect(newerTask).not.toBe(olderTask)
    releaseOlder()
    await until(
      async () =>
        !(await fixture.server.harness.inspect(context)).tasks.some(
          (task) => task.record.id === olderTask,
        ),
    )
    expect((await fixture.read())?.pending).toBe(newerTask)
    expect((await fixture.read())?.status).toBe('pending')
    expect((await fixture.read())?.summary).toBe(previousSummary)
    releaseNewer()
    await until(async () => (await fixture.read())?.status === 'ready')
    expect((await fixture.read())?.summary).toBe('Newer current summary.')
  } finally {
    releaseOlder()
    releaseNewer()
  }
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
}, 60000)

it('resumes pending background generation after shutdown without a stuck checkpoint', async () => {
  const fixture = await launch()
  fixture.generated.mockImplementationOnce(async (_models, _input, signal) => {
    await new Promise((_done, reject) =>
      signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }),
    )
    throw new Error('Unreachable')
  })
  fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
  await (
    await fixture.server.root.submit({ type: 'input', content: 'Summarize this' }, context)
  ).wait(context)
  await until(() => fixture.generated.mock.calls.length === 1)
  await fixture.reopen()
  await until(async () => (await fixture.read())?.status === 'ready')
  expect((await fixture.read())?.exchanges).toBe(1)
  expect(fixture.generated).toHaveBeenCalledTimes(2)
}, 60000)

it('counts only completed inputs, not a yield continued by another hook', async () => {
  const fixture = await launch()
  let continued = false
  fixture.server.host.registry.install(
    defineExtension({
      name: 'summary-continuation',
      hooks: [
        hook(GenerationTask, {
          onYield: () => {
            if (continued) return undefined
            continued = true
            return { continue: 'Continue working.' }
          },
        }),
      ],
    }),
  )
  fixture.server.host.faux!.setResponses([
    fauxAssistantMessage('Intermediate.'),
    fauxAssistantMessage('Final.'),
  ])
  const submitted = await fixture.server.root.submit({ type: 'input', content: 'Work' }, context)
  const settled = await submitted.wait(context)
  expect(settled.status).toBe('done')
  if (settled.status !== 'done' || settled.type !== 'input')
    throw new Error('Expected a settled input')
  await until(async () => (await fixture.read())?.status === 'ready')
  expect((await fixture.read())?.exchanges).toBe(1)
  expect(fixture.generated).toHaveBeenCalledTimes(1)
  const users = (await fixture.server.root.context(context)).entries.filter(
    (entry) => entry.kind === 'pi.user',
  )
  expect(users).toHaveLength(2)
  expect(users.at(-1)?.id).not.toBe(settled.entry)
  const index = async () =>
    (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
      ?.conversations[fixture.server.root.id]
  const assessment = { inputId: settled.entry, answerId: settled.answer, value: 'done' }
  await until(async () => (await index())?.assessmentStatus === 'ready')
  expect(await index()).toMatchObject({
    runState: 'done',
    inputId: settled.entry,
    answerId: settled.answer,
    assessment,
  })
  await fixture.reopen()
  await until(async () => (await index())?.assessmentStatus === 'ready')
  expect(await index()).toMatchObject({
    runState: 'done',
    inputId: settled.entry,
    answerId: settled.answer,
    assessment,
  })
  expect(fixture.generated).toHaveBeenCalledTimes(1)
  // A newer transcript user entry must still invalidate the older reply, even without an input submission.
  const newer = await (
    await fixture.server.root.submit(
      {
        type: 'write',
        entry: {
          kind: 'pi.user',
          model: [
            {
              role: 'user',
              content: 'New context after the assessed reply.',
              timestamp: Date.now(),
            },
          ],
        },
      },
      context,
    )
  ).wait(context)
  expect(newer.status).toBe('done')
  await until(async () => (await index())?.runState === 'idle')
  expect((await index())?.assessment).toBeUndefined()
  expect((await index())?.inputId).toBe(newer.entry)
}, 60000)

it('assesses every idle final reply, keeps summaries between due exchanges, and exposes neutral/failure honestly', async () => {
  const fixture = await launch()
  const index = async () =>
    (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
      ?.conversations[fixture.server.root.id]
  await fixture.exchange()
  await until(async () => (await index())?.assessment?.value === 'done')
  const summary = (await fixture.read())?.summary
  fixture.generated.mockResolvedValueOnce({
    assessment: 'needs_input',
    activity: 'Asked the coordinator to approve the deployment target.',
  })
  await fixture.exchange()
  await until(async () => (await index())?.assessment?.value === 'needs_input')
  expect((await fixture.read())?.summary).toBe(summary)
  expect((await index())?.runState).toBe('done')
  expect((await index())?.assessment?.answerId).toBe((await index())?.answerId)
  fixture.generated.mockResolvedValueOnce({
    assessment: 'neutral',
    activity: 'Outlined unfinished work without claiming completion.',
  })
  await fixture.exchange()
  await until(async () => (await index())?.assessment?.value === 'neutral')
  expect((await fixture.read())?.summary).toBe(summary)
  fixture.generated.mockRejectedValueOnce(new Error('Malformed assessment'))
  await fixture.exchange()
  await until(async () => (await index())?.assessmentStatus === 'error')
  expect((await index())?.assessment).toBeUndefined()
  expect((await fixture.read())?.summary).toBe(summary)
  expect(fixture.generated).toHaveBeenCalledTimes(4)
  const before = await index()
  await fixture.reopen()
  await until(async () => (await index())?.assessmentStatus === 'error')
  expect(await index()).toEqual(before)
  expect(fixture.generated).toHaveBeenCalledTimes(4)
}, 60000)

it('suppresses an old assessment during new actual work and rejects an in-flight result after new input', async () => {
  const fixture = await launch()
  await fixture.exchange()
  let releaseAssessment!: () => void
  let releaseTool!: () => void
  const assessmentGate = new Promise<void>((done) => {
    releaseAssessment = done
  })
  const toolGate = new Promise<void>((done) => {
    releaseTool = done
  })
  let toolStarted = false
  fixture.server.host.registry.install(
    defineExtension({
      name: 'assessment-wait',
      tools: [
        defineTool({
          name: 'assessment_wait',
          description: 'Wait',
          parameters: Type.Object({}),
          execute: async () => {
            toolStarted = true
            await toolGate
            return { content: [{ type: 'text', text: 'Wait complete.' }] }
          },
        }),
      ],
    }),
  )
  fixture.generated.mockImplementationOnce(async () => {
    await assessmentGate
    return { assessment: 'done', activity: 'An old reply whose assessment is now stale.' }
  })
  try {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Second reply.')])
    await (
      await fixture.server.root.submit({ type: 'input', content: 'Second input' }, context)
    ).wait(context)
    await until(() => fixture.generated.mock.calls.length === 2)
    fixture.server.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('assessment_wait', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Third final reply.'),
    ])
    const third = await fixture.server.root.submit(
      { type: 'input', content: 'New work invalidates the old assessment' },
      context,
    )
    await until(() => toolStarted)
    await until(
      async () =>
        (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
          ?.conversations[fixture.server.root.id]?.runState === 'working',
    )
    expect(
      (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
        ?.conversations[fixture.server.root.id]?.assessment,
    ).toBeUndefined()
    releaseAssessment()
    await until(async () => (await fixture.read())?.assessmentStatus === 'error')
    expect((await fixture.read())?.assessment).toBeUndefined()
    expect((await fixture.read())?.summary).toBe('Added concise summaries to the sidebar.')
    releaseTool()
    expect((await third.wait(context)).status).toBe('done')
    await until(async () => (await fixture.read())?.assessmentStatus === 'ready')
    expect((await fixture.read())?.assessment?.answerId).toBe((await fixture.read())?.lastAnswer)
  } finally {
    releaseAssessment()
    releaseTool()
  }
}, 60000)

it('does not reconcile the overview or read summary histories for streamed live chunks', async () => {
  const fixture = await launch()
  await fixture.exchange()
  await until(
    async () =>
      (await fixture.server.harness.snapshot(Overview, fixture.server.root.id, context))
        ?.conversations[fixture.server.root.id]?.assessmentStatus === 'ready',
  )
  const reads = vi.spyOn(fixture.server.harness, 'snapshot')
  let publications = 0
  const stop = fixture.server.harness.subscribeCommits((publication) => {
    publications += publication.changes.filter(
      (change) => change.type === 'document' && change.record.kind === Overview.definition.kind,
    ).length
  })
  try {
    for (let chunk = 0; chunk < 12; chunk++)
      await fixture.server.root.commit(async (tx) => {
        ;(await tx.doc(LiveDoc, fixture.server.root.id)).generation = {
          attempt: 1,
          message: JSON.parse(JSON.stringify(fauxAssistantMessage(`Partial ${chunk}`))),
        }
      }, context)
    await fixture.server.root.commit(async (tx) => {
      delete (await tx.doc(LiveDoc, fixture.server.root.id)).generation
    }, context)
    expect(
      reads.mock.calls.filter((call) => call[0].definition.kind === Summaries.definition.kind),
    ).toHaveLength(0)
    expect(publications).toBe(0)
  } finally {
    stop()
    reads.mockRestore()
  }
}, 60000)

it('skips summaries and assessments quietly when Luna is unavailable', async () => {
  const fixture = await launch()
  const server = fixture.server
  const existing = server.host.registry.snapshot().extension('conversations')!
  server.host.registry.install(
    defineExtension({
      ...existing,
      ...summaryBehavior(
        {
          harness: () => server.harness,
          metadata: Metadata,
          modelRuntime: { getAvailableSnapshot: () => [] },
        },
        fixture.generated,
      ),
    }),
  )
  server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
  await (await server.root.submit({ type: 'input', content: 'Work' }, context)).wait(context)
  await server.harness.waitForIdle(context)
  expect(fixture.generated).not.toHaveBeenCalled()
  expect((await server.harness.inspect(context)).tasks).toHaveLength(0)
  expect((await fixture.read())?.status).toBeUndefined()
  expect((await fixture.read())?.assessmentStatus).toBeUndefined()
  expect((await fixture.read())?.exchanges ?? 0).toBe(0)
  expect(
    (await server.harness.snapshot(Overview, server.root.id, context))?.conversations[
      server.root.id
    ]?.assessmentStatus,
  ).toBeUndefined()
})

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
  const models = {
    getModel: () => ({ provider: 'openai-codex', id: 'gpt-6-luna' }),
    streamSimple: stream,
  } as unknown as Models
  expect(
    await generateSummary(models, 'Untrusted reply text', new AbortController().signal, false),
  ).toEqual(output)
  expect(stream.mock.calls[0][1].systemPrompt).toContain('Do not include title or summary.')
  expect(stream.mock.calls[0][1].systemPrompt).toContain('not necessarily a human')
  for (const value of ['blocked', 'unfinished', ['done'], null]) {
    output = { assessment: value, activity: 'Some work was discussed.' }
    await expect(
      generateSummary(models, 'Reply', new AbortController().signal, false),
    ).rejects.toThrow('Invalid assessment')
  }
})
