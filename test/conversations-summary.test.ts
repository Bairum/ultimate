import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { Model, Models } from '@earendil-works/pi-ai'
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
import {
  generateSummary,
  Summaries,
  summaryBehavior,
  summaryInput,
} from '../extensions/conversations/summary.ts'
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
    title: 'Improve the conversation sidebar',
    summary: 'Added concise summaries to the sidebar.',
  }))
  const install = (registry = server.host.registry) => {
    const existing = registry.snapshot().extension('conversations')!
    registry.install(
      defineExtension({
        ...existing,
        ...summaryBehavior({ harness: () => server.harness, metadata: Metadata }, generated),
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
  await until(() => fixture.generated.mock.calls.length === 2)
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
  await until(() => fixture.generated.mock.calls.length === 3)
  await fixture.server.harness.waitForIdle(context)
  expect(fixture.generated).toHaveBeenCalledTimes(3)
}, 60000)

it('counts distinct completions durably when an older context read finishes after a newer reply', async () => {
  const fixture = await launch()
  const behavior = summaryBehavior(
    { harness: () => fixture.server.harness, metadata: Metadata },
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
    expect(fixture.generated).toHaveBeenCalledTimes(1)
    await fixture.exchange()
    expect((await fixture.read())?.exchanges).toBe(4)
    expect(fixture.generated).toHaveBeenCalledTimes(2)
  } finally {
    release()
  }
}, 60000)

it('replaces only a marked HTTP input fallback and clears its provenance with the generated title', async () => {
  const fixture = await launch()
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  fixture.generated.mockImplementationOnce(async () => {
    await gate
    return { title: 'Improve the conversation sidebar', summary: 'Generated summary.' }
  })
  try {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    expect(
      (
        await post(fixture.server, '/api/conversations/1/submit', {
          text: 'A first prompt that is not a concise title.',
        })
      ).status,
    ).toBe(202)
    await until(() => fixture.generated.mock.calls.length === 1)
    expect(
      await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context),
    ).toMatchObject({ title: 'A first prompt that is not a concise title.', titleSource: 'input' })
    release()
    await until(async () => (await fixture.read())?.status === 'ready')
    const metadata = await fixture.server.harness.snapshot(
      Metadata,
      fixture.server.root.id,
      context,
    )
    expect(metadata?.title).toBe('Improve the conversation sidebar')
    expect(metadata?.titleSource).toBeUndefined()
    await fixture.reopen()
    expect(
      (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))?.title,
    ).toBe('Improve the conversation sidebar')
  } finally {
    release()
  }
}, 60000)

it('never marks or replaces an unmarked preexisting HTTP title equal to the first input', async () => {
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
    return { title: 'An automatically generated title', summary: 'Generated summary.' }
  })
  try {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    expect((await post(fixture.server, '/api/conversations/1/submit', { text })).status).toBe(202)
    await until(() => fixture.generated.mock.calls.length === 1)
    expect(
      (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))
        ?.titleSource,
    ).toBe('input')
    expect((await fixture.action('rename', text)).status).toBe(200)
    expect(
      (await fixture.server.harness.snapshot(Metadata, fixture.server.root.id, context))
        ?.titleSource,
    ).toBeUndefined()
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
  fixture.generated.mockImplementationOnce(async () => {
    await gate
    return { title: 'An automatically updated title', summary: 'Updated summary.' }
  })
  for (let count = 2; count <= 3; count++) await fixture.exchange()
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
    return { title: 'A stale generated title', summary: 'Stale summary.' }
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
  expect(fixture.generated).toHaveBeenCalledTimes(3)
}, 60000)

it('excludes owned children and forks, and does not backfill historical exchanges on install', async () => {
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
    return tx.createConversation({ ownership: { kind: 'task', taskId: owner } })
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
    expect((await fixture.server.harness.snapshot(Summaries, id, context))?.exchanges ?? 0).toBe(0)
  }
  expect(fixture.generated).not.toHaveBeenCalled()
  await fixture.exchange()
  expect(fixture.generated).toHaveBeenCalledTimes(1)
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
    return { title: 'A compacted stale title', summary: 'Compacted stale summary.' }
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
  fixture.generated
    .mockImplementationOnce(async () => {
      await olderGate
      return { title: 'An older compacted title', summary: 'Older compacted summary.' }
    })
    .mockImplementationOnce(async () => {
      await newerGate
      return { title: 'A newer current title', summary: 'Newer current summary.' }
    })
  try {
    let olderTask: number | undefined
    for (let count = 1; count <= 4; count++) {
      fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
      await (
        await fixture.server.root.submit({ type: 'input', content: `Input ${count}` }, context)
      ).wait(context)
      await until(async () => (await fixture.read())?.exchanges === count)
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
    await until(() => fixture.generated.mock.calls.length === 2)
    const newerTask = (await fixture.read())?.pending
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
    expect((await fixture.read())?.summary).toBeUndefined()
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
    return { title: 'An older stale title', summary: 'Older stale summary.' }
  })
  for (let count = 1; count <= 4; count++) {
    fixture.server.host.faux!.setResponses([fauxAssistantMessage('Done.')])
    await (
      await fixture.server.root.submit({ type: 'input', content: `Exchange ${count}` }, context)
    ).wait(context)
    await until(async () => (await fixture.read())?.exchanges === count)
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
  expect(
    (
      await (
        await fixture.server.root.submit({ type: 'input', content: 'Work' }, context)
      ).wait(context)
    ).status,
  ).toBe('done')
  await until(async () => (await fixture.read())?.status === 'ready')
  expect((await fixture.read())?.exchanges).toBe(1)
  expect(fixture.generated).toHaveBeenCalledTimes(1)
}, 60000)

it('selects Luna/medium with bounded text-only context and cancels oversized output', async () => {
  const model = { provider: 'openai-codex', id: 'gpt-6-luna' }
  const stream = vi.fn<Models['streamSimple']>((_model, _input, options) => {
    const events = new AssistantMessageEventStream()
    const answer = fauxAssistantMessage(
      JSON.stringify({ title: 'A compact useful title', summary: 'A brief current summary.' }),
    )
    events.push({ type: 'done', reason: 'stop', message: answer })
    events.end()
    expect(options?.reasoning).toBe('medium')
    expect(options?.maxTokens).toBe(2048)
    return events
  })
  const getModel = vi.fn<Models['getModel']>(() => model as Model<string>)
  const models = { getModel, streamSimple: stream } as unknown as Models
  const input = summaryInput([
    { role: 'user', content: 'x'.repeat(50000), timestamp: 1 },
    fauxAssistantMessage('y'.repeat(50000)),
  ])
  expect(input.length).toBeLessThanOrEqual(12060)
  expect(await generateSummary(models, input, new AbortController().signal)).toEqual({
    title: 'A compact useful title',
    summary: 'A brief current summary.',
  })
  expect(getModel).toHaveBeenCalledWith('openai-codex', 'gpt-6-luna')
  expect(stream.mock.calls[0][1].tools).toBeUndefined()
  stream.mockImplementationOnce((_model, _input, options) => {
    const events = new AssistantMessageEventStream()
    events.push({
      type: 'text_delta',
      contentIndex: 0,
      delta: 'z'.repeat(2049),
      partial: fauxAssistantMessage('z'.repeat(2049)),
    })
    options!.signal!.addEventListener('abort', () => events.end())
    return events
  })
  await expect(generateSummary(models, input, new AbortController().signal)).rejects.toThrow(
    'exceeds bounds',
  )
  expect(stream.mock.calls[1][2]?.signal?.aborted).toBe(true)
})
