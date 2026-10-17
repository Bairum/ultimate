import { expect, it } from 'vitest'
import {
  CompactionTask,
  configure,
  defineExtension,
  defineDoc,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Roots, Tally } from '../extensions/lineage/server.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { attach, fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

it('creates roots once, seeds them, and compacts only available tallies with the root focus', async () => {
  const home = await temp()
  const server = await fauxServer({ ultimateRoot: await sourceCopy(home), home, userHome: home })
  const release = Promise.withResolvers<void>()
  const anchor = defineTask<null, { phase: 'wait' }, null>({
    name: 'tally-test.anchor',
    version: 1,
    initial: () => ({ phase: 'wait' }),
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
    phases: {
      wait: async (_task, runtime, ctx) => {
        await release.promise
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          ctx,
        )
      },
    },
  })
  const compacting = Promise.withResolvers<void>()
  const finishCompact = Promise.withResolvers<void>()
  try {
    server.host.registry.install(defineExtension({ name: 'tally-test', tasks: [anchor] }))
    const taskId = await server.harness.commit(
      (tx) =>
        tx.createTask(anchor, null, {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        }),
      context,
    )
    const caller = await server.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      context,
    )
    await server.harness.commit(async (tx) => {
      await configure(tx, ROOT_CONVERSATION_ID, { thinkingLevel: 'high' })
      await tx.appendEntry(caller.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Read the project', timestamp: 0 }],
      })
    }, context)
    const tools = server.host.registry.snapshot().extension('lineage')!.tools!
    const create = tools.find((tool) => tool.name === 'new_root')!
    const seed = tools.find((tool) => tool.name === 'seed_tally')!
    const compact = tools.find((tool) => tool.name === 'compact_tally')!
    expect([create, seed, compact].every((tool) => tool.deferred)).toBe(true)
    const memos = new Map<string, unknown>()
    const api = {
      conversationId: caller.id,
      taskId,
      callId: 'new-root',
      memo: async (key: string, ...args: unknown[]) => {
        if (args.length === 2 && !memos.has(key)) memos.set(key, args[0])
        return memos.get(key)
      },
      commit: (change: Parameters<typeof server.harness.commit>[0]) =>
        server.harness.commit(change, context),
    } as unknown as Parameters<typeof create.execute>[1]
    const created = await create.execute({ title: 'Independent work' }, api, context)
    const id = JSON.parse(created.output!.filter((part) => part.type === 'text')[0].text)
      .id as ConversationId
    const conversation = (await server.harness.conversation(id, context))!
    const record = await server.harness.commit((tx) => tx.conversation(id), context)
    expect(record?.owner).toBeUndefined()
    expect(record?.parent).toBeUndefined()
    expect((await server.harness.snapshot(Roots, ROOT_CONVERSATION_ID, context))?.roots).toEqual([
      1,
      id,
    ])
    expect((await conversation.context(context)).entries).toEqual([])
    const defaults = await server.root.agent(context)
    expect(await conversation.agent(context)).toMatchObject({
      cwd: server.host.projectRoot,
      model: defaults.model,
      thinkingLevel: 'high',
    })
    expect((await server.harness.snapshot(Metadata, id, context))?.title).toBe('Independent work')
    expect(await create.execute({ title: 'Independent work' }, api, context)).toEqual(created)
    // Crash after creation but before the memo: the transactional receipt still wins.
    memos.clear()
    expect(await create.execute({ title: 'Independent work' }, api, context)).toEqual(created)
    expect((await server.harness.snapshot(Roots, ROOT_CONVERSATION_ID, context))?.roots).toEqual([
      1,
      id,
    ])
    await expect(create.execute({ title: ' ' }, api, context)).rejects.toThrow('needs a title')
    await expect(compact.execute({ root: caller.id }, api, context)).rejects.toThrow(
      'not a listed root',
    )
    await expect(compact.execute({ root: id }, api, context)).rejects.toThrow('not a tally')
    await seed.execute({ root: id, text: 'Project reading: run pnpm test.' }, api, context)
    expect((await server.harness.snapshot(Tally, id, context))?.since).toBeDefined()
    await server.harness.commit(async (tx) => {
      for (let n = 0; n < 8; n++)
        await tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
    let prompt = ''
    server.host.faux!.setResponses([
      async (transcript) => {
        prompt = JSON.stringify(transcript.messages)
        compacting.resolve()
        await finishCompact.promise
        return fauxAssistantMessage(
          'Root summary: keep standing decisions and #conversation/entry.',
        )
      },
    ])
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        compact.execute(
          { root: id, instructions: 'Drop the obsolete deployment plan.' },
          api,
          context,
        ),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: `#${id} is already compacting` }),
    })
    const tasks = await server.harness.commit(
      (tx) => tx.scanTasks({ conversationId: id, kind: CompactionTask.definition.name }, 10),
      context,
    )
    expect(tasks.items).toHaveLength(1)
    const accepted = results.find((result) => result.status === 'fulfilled')!.value
    const compaction = JSON.parse(accepted.output!.filter((part) => part.type === 'text')[0].text)
      .taskId as TaskId
    await compacting.promise
    await expect(compact.execute({ root: id }, api, context)).rejects.toThrow('already compacting')
    finishCompact.resolve()
    expect((await server.harness.waitForTask(compaction, context)).state.outcome.status).toBe(
      'completed',
    )
    expect(prompt).toContain('This is the tally of one line of work')
    expect(prompt).toContain('standing decisions')
    expect(prompt).toContain('Drop the obsolete deployment plan.')
    expect(JSON.stringify((await conversation.context(context)).messages)).toContain('Root summary')
  } finally {
    finishCompact.resolve()
    release.resolve()
    await server.close()
  }
})

it('reopens and branches from stored survey inputs, side notes and retired side documents', async () => {
  const home = await temp()
  const options = { ultimateRoot: await sourceCopy(home), home, userHome: home }
  const legacySide = defineDoc<{ side?: { root: number; at: number; ended: string } }>({
    kind: 'lineage.side',
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    initial: () => ({}),
  })
  let server = await fauxServer(options)
  try {
    await server.harness.commit(async (tx) => {
      const survey = await tx.appendEntry(ROOT_CONVERSATION_ID, {
        kind: 'lineage.survey',
        data: { focus: 'Old project reading' },
        model: [{ role: 'user', content: 'Old project reading', timestamp: 0 }],
      })
      ;(await tx.doc(legacySide, ROOT_CONVERSATION_ID)).side = {
        root: 1,
        at: survey.id,
        ended: 'note',
      }
      await tx.appendEntry(ROOT_CONVERSATION_ID, {
        kind: 'lineage.note',
        data: { source: 'side', from: 2, text: 'An old decision' },
        model: [{ role: 'user', content: 'Side chat #2: An old decision', timestamp: 0 }],
      })
    }, context)
    const storedSide = await server.harness.snapshot(legacySide, ROOT_CONVERSATION_ID, context)
    await server.close()
    server = await fauxServer(options)
    await expect(
      server.root.submit({ type: 'input', content: 'Reopen the side chat' }, context),
    ).rejects.toThrow('has ended and takes no input')
    const stream = await attach(server, '?conversation=1&docs=lineage.side')
    try {
      await until(() => stream.events.some((event) => event.name === 'doc'))
      expect(stream.events.find((event) => event.name === 'doc')!.data).toEqual({
        kind: 'lineage.side',
        value: storedSide,
      })
    } finally {
      await stream.close()
    }
    const branch = await post(server, '/api/extensions/lineage/actions/branch', {
      args: { from: 1, prompt: 'Continue the work', isolated: false },
    })
    expect(branch.status).toBe(200)
    const conversation = (await server.harness.conversation(branch.data.result.id, context))!
    await server.harness.waitForIdle(context)
    const messages = JSON.stringify((await conversation.context(context)).messages)
    expect(messages).toContain('Old project reading')
    expect(messages).toContain('An old decision')
  } finally {
    await server.close()
  }
})
