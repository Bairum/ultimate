import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { Branch } from '../extensions/lineage/server.ts'
import { Plan } from '../extensions/plan/server.ts'
import { Summaries, summaryBehavior } from '../extensions/conversations/summary.ts'
import { defineExtension, defineTask } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { HistoryResponse } from '../shared/protocol.ts'
import { fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['plan', 'subagents'] } }),
  )
})

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((part) => (part.type === 'text' ? [part.text!] : []))
        .join('')

/** The installed `lineage` prompt section as it renders for `id`. */
function section(server: Server, id: ConversationId) {
  const lineage = server.host.registry.snapshot().extension('lineage')!.sections![0]
  return lineage.render({ conversationId: id } as Parameters<typeof lineage.render>[0], context)
}

/** A faux server whose provider answers briefs with BRIEF and everything else with the last user text echoed. */
async function fixture(reopen?: string) {
  const home = reopen ?? (await temp('ultimate-lineage-'))
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const briefs: string[] = []
  const failures = { brief: false }
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const [system, first] = transcript.messages
    if (textOf(system.content).startsWith('Write the brief')) {
      briefs.push(textOf(first.content))
      return failures.brief
        ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider down' })
        : fauxAssistantMessage('BRIEF: keep going')
    }
    if (textOf(system.content).startsWith('You condense'))
      return fauxAssistantMessage(`LINEAGE SUMMARY of ${textOf(first.content).slice(0, 40)}`)
    const final = transcript.messages.at(-1)!
    if (final.role === 'toolResult') return fauxAssistantMessage(`Tool: ${textOf(final.content)}`)
    const last = transcript.messages.findLast((message) => message.role === 'user')
    if (textOf(last?.content).startsWith('NOTIFY '))
      return fauxAssistantMessage(
        [fauxToolCall('notify', JSON.parse(textOf(last?.content).slice(7)))],
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage(`echo ${textOf(last?.content)}`)
  }
  server.host.faux!.setResponses([route])
  return { server, home, briefs, failures }
}

it('branches with a brief, marks the source, and keeps inherited history reachable', async () => {
  const { server, briefs } = await fixture()
  await (
    await server.root.submit(
      { type: 'input', content: 'We build a tree of conversations.' },
      context,
    )
  ).wait(context)
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Plan, server.root.id)).epics.E1 = {
      key: 'E1',
      title: 'Root work',
      body: 'Body',
      status: 'in_progress',
      tasks: {},
    }
  }, context)
  // Ordinary forks (including subagent history forks) still inherit the ledger.
  const forkAt = await server.harness.commit(
    async (tx) => (await tx.appendEntry(server.root.id, { kind: 'test.after-plan', data: {} })).id,
    context,
  )
  const ordinary = await server.root.fork(forkAt, { ownership: { kind: 'ownerless' } }, context)
  expect(Object.keys((await server.harness.snapshot(Plan, ordinary.id, context))!.epics)).toEqual([
    'E1',
  ])
  const { messages: seen } = await server.root.context(context)
  const answer = (await server.root.entries({}, 1, undefined, context)).items[0].id
  const publications: import('@earendil-works/pi-durable').CommitPublication[] = []
  const stop = server.harness.subscribeCommits((publication) => publications.push(publication))
  const { status, data } = await post(server, '/api/extensions/lineage/actions/branch', {
    args: { from: 1, prompt: 'Add notes between conversations' },
  })
  expect(status).toBe(200)
  const id = data.result.id as ConversationId
  stop()
  const creation = publications.find((publication) =>
    publication.changes.some((change) => change.type === 'conversation' && change.value.id === id),
  )!
  const initialized = (kind: string) =>
    creation.changes.find(
      (change) =>
        change.type === 'document' && change.conversationId === id && change.record.kind === kind,
    )
  expect(initialized(Metadata.definition.kind)).toMatchObject({
    value: { title: 'Add notes between conversations' },
  })
  expect(initialized(Summaries.definition.kind)).toMatchObject({
    value: { generatedTitle: 'Add notes between conversations' },
  })
  expect(initialized(Plan.definition.kind)).toMatchObject({ value: { next: 1, epics: {} } })
  const branch = (await server.harness.conversation(id, context))!
  await until(
    async () => (await server.harness.snapshot(Branch, id, context))?.branch?.status === 'ready',
  )
  await branch.waitForIdle(context)
  // A branch starts with an empty plan; the root keeps its own.
  expect((await server.harness.snapshot(Plan, id, context))?.epics).toEqual({})
  expect(
    Object.keys((await server.harness.snapshot(Plan, server.root.id, context))!.epics),
  ).toEqual(['E1'])

  // The brief read the source context, tagged with entry ids.
  expect(briefs).toHaveLength(1)
  expect(briefs[0]).toContain('We build a tree of conversations.')
  expect(briefs[0]).toMatch(/#1\/\d+/)

  // The source got a display-only marker its model never sees.
  const source = await server.root.context(context)
  const marker = source.entries.at(-1)!
  expect(marker.kind).toBe('lineage.branched')
  expect(marker.model).toBeUndefined()
  // `at` defaults to the source's latest entry: the answer, or a display entry written after it.
  const { at } = marker.data as { at: number }
  expect(at).toBeGreaterThanOrEqual(answer)
  expect(at).toBeLessThan(marker.id)
  expect(marker.data).toEqual({ branch: id, at, intent: 'Add notes between conversations' })
  expect(source.messages).toEqual(seen)

  // The branch's model sees the brief reset, then the prompt and its answer.
  const view = await branch.context(context)
  // Display entries (a branch is top-level, so it gets the sidebar summary) carry no model message.
  expect(view.entries.filter((entry) => entry.model).map((entry) => entry.kind)).toEqual([
    'pi.reset',
    'pi.user',
    'pi.system',
    'pi.assistant',
  ])
  expect(view.entries[0].data).toEqual({ lineage: { from: 1, at } })
  const said = view.messages
    .filter((message) => message.role !== 'system')
    .map((message) => [message.role, textOf(message.content)])
  expect(said).toEqual([
    ['user', `<brief from="#1/${at}">\nBRIEF: keep going\n</brief>`],
    ['user', 'Add notes between conversations'],
    ['assistant', 'echo Add notes between conversations'],
  ])
  expect((await branch.agent(context)).cwd).toBe(server.host.projectRoot)

  // History pages from the branch back into the entries it inherited.
  const history = (await (
    await fetch(`${server.url}/api/conversations/${id}/history?before=${view.entries[0].id}`)
  ).json()) as HistoryResponse
  expect(
    history.entries.some(
      (entry: EntryRecord) =>
        entry.conversationId === ROOT_CONVERSATION_ID &&
        textOf(entry.model?.[0]?.content) === 'We build a tree of conversations.',
    ),
  ).toBe(true)

  // The prompt section names each conversation's place in the tree.
  expect(await section(server, ROOT_CONVERSATION_ID)).toMatch(
    /^You are a root of this project \(#1\): you hold the idea of one line of work/,
  )
  expect(await section(server, id)).toContain(
    `You are #${id}, branched from #1 at entry ${at} for: Add notes between conversations\nRoot: #1.`,
  )

  // A branch already has a root, so it cannot become one.
  const refused = await post(server, '/api/extensions/lineage/actions/root', { args: { id } })
  expect(refused.status).not.toBe(200)
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: { id } })).data.result,
  ).toMatchObject({
    roots: [1],
    root: 1,
    branch: { from: 1, intent: 'Add notes between conversations' },
  })
})

it('lets a summary replace the provisional branch title', async () => {
  const { server, failures } = await fixture()
  await (
    await server.root.submit({ type: 'input', content: 'Inherited idea.' }, context)
  ).wait(context)
  failures.brief = true
  const { id } = (
    await post(server, '/api/extensions/lineage/actions/branch', {
      args: { from: 1, prompt: 'New intent' },
    })
  ).data.result as { id: ConversationId }
  await until(
    async () => (await server.harness.snapshot(Branch, id, context))?.branch?.status === 'failed',
  )
  expect((await server.harness.snapshot(Summaries, id, context))?.generatedTitle).toBe('New intent')
  expect(server.api.conversations().find((item) => item.id === id)?.title).toBe('New intent')
  const existing = server.host.registry.snapshot().extension('conversations')!
  server.host.registry.install(
    defineExtension({
      ...existing,
      ...summaryBehavior(
        {
          harness: () => server.harness,
          metadata: Metadata,
          userHome: server.host.userHome,
          projectSettings: async () => ({}),
          notice: () => {},
          modelRuntime: {
            getAvailableSnapshot: () =>
              server.host.modelRuntime
                .getModels()
                .filter((model) => model.provider === 'openai' && model.id === 'gpt-6-luna'),
          },
        },
        async () => ({
          assessment: 'done',
          activity: 'Finished the new work.',
          title: 'Summarized branch',
          summary: 'Finished the new work.',
        }),
      ),
    }),
  )
  failures.brief = false
  await post(server, '/api/extensions/lineage/actions/retry', { args: { id } })
  await until(
    async () =>
      (await server.harness.snapshot(Metadata, id, context))?.title === 'Summarized branch',
  )
  expect((await server.harness.snapshot(Summaries, id, context))?.generatedTitle).toBe(
    'Summarized branch',
  )
})

it('sorts a new branch from the moment it was asked for, not by the history it inherited', async () => {
  const { server, failures } = await fixture()
  await (
    await server.root.submit({ type: 'input', content: 'An old idea.' }, context)
  ).wait(context)
  await until(
    async () =>
      (await server.harness.snapshot(Metadata, server.root.id, context))?.inputAt !== undefined,
  )
  const inherited = (await server.harness.snapshot(Metadata, server.root.id, context))!.inputAt!
  failures.brief = true
  const asked = Date.now()
  const { id } = (
    await post(server, '/api/extensions/lineage/actions/branch', {
      args: { from: server.root.id, prompt: 'New intent' },
    })
  ).data.result as { id: ConversationId }
  // Activity has read the inherited history: its first input names it.
  await until(
    async () =>
      (await server.harness.snapshot(Metadata, id, context))?.inputTitle === 'An old idea.',
  )
  const inputAt = (await server.harness.snapshot(Metadata, id, context))!.inputAt!
  expect(inputAt).toBeGreaterThanOrEqual(asked)
  expect(inputAt).toBeGreaterThan(inherited)
})

it('leaves a note in an idle conversation without starting a run', async () => {
  const { server } = await fixture()
  const note = server.host.registry.snapshot().extension('lineage')!.tools![0]
  const other = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const result = await note.execute(
    { to: other.id, text: 'The schema changed.' },
    {
      conversationId: ROOT_CONVERSATION_ID,
    } as Parameters<typeof note.execute>[1],
    context,
  )
  expect(textOf(result.output)).toBe(`Left a note in #${other.id}.`)
  const view = await other.context(context)
  expect(view.entries.map((entry) => [entry.kind, entry.data])).toEqual([
    ['lineage.note', { text: 'The schema changed.', from: 1 }],
  ])
  expect(textOf(view.messages[0].content)).toBe('Note from #1: The schema changed.')
  expect((await server.harness.snapshot(LiveDoc, other.id, context))?.run).toBeUndefined()
  const tasks = await server.harness.commit(
    async (tx) => (await tx.scanTasks({ conversationId: other.id }, 10)).items,
    context,
  )
  expect(tasks).toEqual([])
})

it('marks a failed brief and starts it again on retry', async () => {
  const { server, failures } = await fixture()
  await (await server.root.submit({ type: 'input', content: 'An idea.' }, context)).wait(context)
  failures.brief = true
  const { id } = (
    await post(server, '/api/extensions/lineage/actions/branch', {
      args: { from: 1, prompt: 'Try it' },
    })
  ).data.result as { id: ConversationId }
  const state = async () => (await server.harness.snapshot(Branch, id, context))?.branch
  await until(async () => (await state())?.status === 'failed')
  expect((await state())?.error).toBe('provider down')
  const branch = (await server.harness.conversation(id, context))!
  expect((await branch.context(context)).entries.some((entry) => entry.kind === 'pi.reset')).toBe(
    false,
  )
  failures.brief = false
  expect(
    (await post(server, '/api/extensions/lineage/actions/retry', { args: { id } })).status,
  ).toBe(200)
  await until(async () => (await state())?.status === 'ready')
  await branch.waitForIdle(context)
  expect((await branch.context(context)).entries[0].kind).toBe('pi.reset')
})

it('names a branch by its intent and notifies only once its own work ends', async () => {
  const { server } = await fixture()
  await (await server.root.submit({ type: 'input', content: 'An idea.' }, context)).wait(context)
  const { id } = (
    await post(server, '/api/extensions/lineage/actions/branch', {
      args: { from: 1, prompt: 'Fix the lost answers' },
    })
  ).data.result as { id: ConversationId }
  // While the brief is written, the title is the intent, not the root's first message.
  expect((await server.harness.snapshot(Metadata, id, context))?.title).toBe('Fix the lost answers')
  await server.root.submit({ type: 'input', content: `NOTIFY ${JSON.stringify({ id })}` }, context)
  await until(
    async () => (await server.harness.snapshot(Branch, id, context))?.branch?.status === 'ready',
  )
  await (await server.harness.conversation(id, context))!.waitForIdle(context)
  await until(async () =>
    (await server.root.context(context)).entries.some((entry) => entry.kind === 'lineage.finished'),
  )
  const finished = (await server.root.context(context)).entries.find(
    (entry) => entry.kind === 'lineage.finished',
  )!
  // The branch's own answer, never one it inherited from the root.
  expect((finished.data as { text: string }).text).toBe('echo Fix the lost answers')
})

it('compacts a top-level conversation with its lineage focus', async () => {
  const { server } = await fixture()
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 8; n++) {
      await tx.appendEntry(server.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
    }
  }, context)
  const task = await server.root.compact(undefined, context)
  await server.harness.waitForTask(task, context)
  const marker = (await server.root.context(context)).entries[0]
  expect(marker.kind).toBe('pi.compaction')
  expect(textOf(marker.model?.[0]?.content)).toContain(
    'LINEAGE SUMMARY of This is a root conversation',
  )
})

/** A faux server where `NOTIFY {json}` calls the notify tool and `HOLD` answers only once released. */
async function notifyFixture(reopen?: string) {
  const home = reopen ?? (await temp('ultimate-lineage-'))
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const hold = Promise.withResolvers<void>()
  const route: FauxResponseFactory = async (transcript, options) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.at(-1)!
    const text = textOf(last.content)
    if (last.role === 'toolResult') return fauxAssistantMessage(`Tool: ${text}`)
    if (text.startsWith('NOTIFY '))
      return fauxAssistantMessage([fauxToolCall('notify', JSON.parse(text.slice(7)))], {
        stopReason: 'toolUse',
      })
    if (text === 'HOLD')
      await Promise.race([
        hold.promise,
        new Promise((_, fail) =>
          options?.signal?.addEventListener('abort', () => fail(new Error('aborted'))),
        ),
      ])
    return fauxAssistantMessage(`echo ${text}`)
  }
  server.host.faux!.setResponses([route])
  return { server, home, release: () => hold.resolve() }
}

/** A second top-level conversation with the root's model. */
async function second(server: Server) {
  const { model } = await server.root.agent(context)
  return server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model } },
    context,
  )
}

const ask = async (server: Server, id: ConversationId, content: string) =>
  (
    await (await server.harness.conversation(id, context))!.submit(
      { type: 'input', content },
      context,
    )
  ).wait(context)

const pendingNotifies = (server: Server) =>
  server.harness.commit(
    async (tx) =>
      (
        await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: 'lineage.notify' }, 50)
      ).items.filter((task) => task.state.status !== 'terminal'),
    context,
  )

const kinds = async (server: Server, id: ConversationId) =>
  (await (await server.harness.conversation(id, context))!.context(context)).entries.map(
    (entry) => entry.kind,
  )

it('wakes the caller once when the conversation it waits on finishes', async () => {
  const { server, release } = await notifyFixture()
  const other = await second(server)
  const held = (await server.harness.conversation(other.id, context))!.submit(
    { type: 'input', content: 'HOLD' },
    context,
  )
  await held
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id })}`)
  expect(await pendingNotifies(server)).toHaveLength(1)
  expect(await kinds(server, ROOT_CONVERSATION_ID)).not.toContain('lineage.finished')
  release()
  await until(async () => (await pendingNotifies(server)).length === 0)
  await server.root.waitForIdle(context)
  const view = await server.root.context(context)
  const finished = view.entries.filter((entry) => entry.kind === 'lineage.finished')
  expect(finished).toHaveLength(1)
  expect(finished[0].data).toEqual({ from: other.id, title: 'HOLD', text: 'echo HOLD' })
  expect(textOf(finished[0].model?.[0]?.content)).toBe(
    `#${other.id} finished · HOLD\n\nIts last answer:\necho HOLD`,
  )
  // The delivery started a run that answered it.
  expect(view.entries.at(-1)!.kind).toBe('pi.assistant')
  expect(textOf(view.entries.at(-1)!.model?.[0]?.content)).toContain(`#${other.id} finished`)
})

it('leaves a note without waking the caller when wake is false', async () => {
  const { server } = await notifyFixture()
  const other = await second(server)
  await ask(server, other.id, 'Done already')
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`)
  await until(async () => (await kinds(server, ROOT_CONVERSATION_ID)).includes('lineage.note'))
  await until(async () => (await pendingNotifies(server)).length === 0)
  const view = await server.root.context(context)
  const note = view.entries.at(-1)!
  expect(note.kind).toBe('lineage.note')
  expect(note.data).toEqual({
    text: 'echo Done already',
    from: other.id,
    source: 'finished',
    title: 'Done already',
  })
  expect(
    (await server.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run,
  ).toBeUndefined()
})

it('keeps one pending notify per target and delivers it once across a reopen', async () => {
  const { server, home } = await notifyFixture()
  const other = await second(server)
  await (await server.harness.conversation(other.id, context))!.submit(
    { type: 'input', content: 'HOLD' },
    context,
  )
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id })}`)
  await ask(server, ROOT_CONVERSATION_ID, `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`)
  const pending = await pendingNotifies(server)
  expect(pending.map((task) => task.input)).toEqual([{ target: other.id, wake: false }])

  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const { server: reopened, release } = await notifyFixture(home)
  expect(await pendingNotifies(reopened)).toHaveLength(1)
  release()
  await until(async () => (await pendingNotifies(reopened)).length === 0)
  await reopened.root.waitForIdle(context)
  const entries = await kinds(reopened, ROOT_CONVERSATION_ID)
  expect(entries.filter((kind) => kind === 'lineage.note')).toHaveLength(1)
  expect(entries).not.toContain('lineage.finished')
})

it.each([false, true])(
  'notifies after the brief and run without waiting for the branch’s pending notify (old checkpoint: %s)',
  async (oldCheckpoint) => {
    const { server } = await fixture()
    const other = await second(server)
    const brief = Promise.withResolvers<void>()
    const run = Promise.withResolvers<void>()
    const unrelated = Promise.withResolvers<void>()
    const briefStarted = Promise.withResolvers<void>()
    const runStarted = Promise.withResolvers<void>()
    const otherStarted = Promise.withResolvers<void>()
    const intent = `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`
    const route: FauxResponseFactory = async (transcript) => {
      server.host.faux!.appendResponses([route])
      if (textOf(transcript.messages[0].content).startsWith('Write the brief')) {
        briefStarted.resolve()
        await brief.promise
        return fauxAssistantMessage('BRIEF: start the branch')
      }
      const last = transcript.messages.at(-1)!
      const text = textOf(last.content)
      if (last.role === 'toolResult') return fauxAssistantMessage('Branch run finished')
      if (text === 'HOLD') {
        otherStarted.resolve()
        await unrelated.promise
      }
      if (text === intent) {
        runStarted.resolve()
        await run.promise
      }
      if (text.startsWith('NOTIFY '))
        return fauxAssistantMessage([fauxToolCall('notify', JSON.parse(text.slice(7)))], {
          stopReason: 'toolUse',
        })
      return fauxAssistantMessage(`echo ${text}`)
    }
    server.host.faux!.setResponses([route])
    try {
      await other.submit({ type: 'input', content: 'HOLD' }, context)
      await otherStarted.promise
      const { data } = await post(server, '/api/extensions/lineage/actions/branch', {
        args: { from: 1, prompt: intent },
      })
      const target = data.result.id as ConversationId
      await briefStarted.promise
      const state = (await server.harness.snapshot(Branch, target, context))!.branch!
      expect(state.status).toBe('briefing')
      expect(state.brief).toBeDefined()
      if (oldCheckpoint)
        await server.harness.commit(async (tx) => {
          delete (await tx.doc(Branch, target)).branch!.brief
        }, context)
      await ask(server, server.root.id, `NOTIFY ${JSON.stringify({ id: target, wake: false })}`)
      expect(await pendingNotifies(server)).toHaveLength(1)
      expect(await kinds(server, server.root.id)).not.toContain('lineage.note')
      brief.resolve()
      await runStarted.promise
      expect(await pendingNotifies(server)).toHaveLength(1)
      expect(await kinds(server, server.root.id)).not.toContain('lineage.note')
      run.resolve()
      await until(async () => (await pendingNotifies(server)).length === 0)
      const notes = (await server.root.context(context)).entries.filter(
        (entry) => entry.kind === 'lineage.note',
      )
      expect(notes).toHaveLength(1)
      expect(notes[0].data).toMatchObject({ from: target, text: 'Branch run finished' })
      const pending = await server.harness.commit(
        async (tx) =>
          (await tx.scanTasks({ conversationId: target, kind: 'lineage.notify' }, 50)).items.filter(
            (task) => task.state.status !== 'terminal',
          ),
        context,
      )
      expect(pending.map((task) => task.input)).toEqual([{ target: other.id, wake: false }])
      expect((await server.harness.snapshot(LiveDoc, other.id, context))?.run).toBeDefined()
    } finally {
      brief.resolve()
      run.resolve()
      unrelated.resolve()
    }
  },
)

it('branches in the shared checkout with workspaces disabled', async () => {
  const home = await temp('ultimate-lineage-no-workspaces-')
  const source = await sourceCopy(home)
  await writeFile(
    join(source, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['workspaces'] } }),
  )
  const server = await fauxServer({ ultimateRoot: source, home, userHome: home })
  servers.push(server)
  expect(server.host.registry.snapshot().extension('workspaces')).toBeUndefined()
  const { status, data } = await post(server, '/api/extensions/lineage/actions/branch', {
    args: { from: 1, prompt: 'Shared intent', isolated: false },
  })
  expect(status).toBe(200)
  const id = data.result.id as ConversationId
  const branch = (await server.harness.conversation(id, context))!
  expect(branch.id).toBe(id)
  await until(
    async () => (await server.harness.snapshot(Branch, id, context))?.branch?.status === 'ready',
  )
  await branch.waitForIdle(context)
})

it('starts a new root whose first input is the prompt, without a brief', async () => {
  const { server, briefs } = await fixture()
  const { status, data } = await post(server, '/api/extensions/lineage/actions/newRoot', {
    args: { prompt: '  A second line of work  ', isolated: false },
  })
  expect(status).toBe(200)
  const id = data.result.id as ConversationId
  const root = (await server.harness.conversation(id, context))!
  await root.waitForIdle(context)
  expect(await server.harness.commit((tx) => tx.conversation(id), context)).toEqual({ id })
  expect((await server.harness.snapshot(Metadata, id, context))?.title).toBe(
    'A second line of work',
  )
  expect((await server.harness.snapshot(Summaries, id, context))?.generatedTitle).toBe(
    'A second line of work',
  )
  const view = await root.context(context)
  expect(view.entries.some((entry) => entry.kind === 'pi.reset')).toBe(false)
  expect(
    view.messages
      .filter((message) => message.role !== 'system')
      .map((message) => [message.role, textOf(message.content)]),
  ).toEqual([
    ['user', 'A second line of work'],
    ['assistant', 'echo A second line of work'],
  ])
  expect(briefs).toEqual([])
  expect((await server.harness.snapshot(Branch, id, context))?.branch).toBeUndefined()
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: null })).data.result,
  ).toEqual({ roots: [1, id] })
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: { id } })).data.result,
  ).toEqual({ roots: [1, id], root: id })
  expect(await section(server, id)).toMatch(
    new RegExp(`^You are a root of this project \\(#${id}\\)`),
  )
  expect(
    (await post(server, '/api/extensions/lineage/actions/newRoot', { args: { prompt: ' ' } }))
      .status,
  ).not.toBe(200)
})

it('delivers a new root’s prompt once when the process stops before it is submitted', async () => {
  const { server, home } = await fixture()
  // Without the prompt task's definition the task waits, as if the process went down right after creating the root.
  const lineage = server.host.registry.snapshot().extension('lineage')!
  server.host.registry.install(
    defineExtension({
      ...lineage,
      tasks: lineage.tasks!.filter((task) => task.definition.name !== 'lineage.prompt'),
    }),
  )
  const { data } = await post(server, '/api/extensions/lineage/actions/newRoot', {
    args: { prompt: 'Survive a crash', isolated: false },
  })
  const id = data.result.id as ConversationId
  const prompts = (target: Server) =>
    target.harness.commit(
      async (tx) => (await tx.scanTasks({ conversationId: id, kind: 'lineage.prompt' }, 10)).items,
      context,
    )
  expect((await prompts(server)).map((task) => [task.input, task.state.status])).toEqual([
    [{ id, prompt: 'Survive a crash' }, 'pending'],
  ])
  expect(await kinds(server, id)).toEqual([])
  await server.close()
  servers.splice(servers.indexOf(server), 1)

  const { server: reopened } = await fixture(home)
  await until(async () => (await prompts(reopened))[0].state.status === 'terminal')
  const root = (await reopened.harness.conversation(id, context))!
  await root.waitForIdle(context)
  // A rerun of the delivery finds the submitted input by its request id.
  await root.submit(
    { type: 'input', content: 'Survive a crash', requestId: 'lineage:root' },
    context,
  )
  await root.waitForIdle(context)
  expect(
    (await root.context(context)).messages
      .filter((message) => message.role !== 'system')
      .map((message) => [message.role, textOf(message.content)]),
  ).toEqual([
    ['user', 'Survive a crash'],
    ['assistant', 'echo Survive a crash'],
  ])
})

it('defaults a branch to its source’s configuration and a new root to the project default', async () => {
  const { server } = await fixture()
  const model = { provider: 'faux', modelId: 'faux-b' }
  const other = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model, thinkingLevel: 'high' } },
    context,
  )
  await post(server, '/api/extensions/lineage/actions/root', { args: { id: other.id } })
  const defaults = async (args: unknown) =>
    (await post(server, '/api/extensions/models/actions/defaultConfiguration', { args })).data
  const project = await server.root.agent(context)
  expect(project.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
  expect(await defaults({ id: other.id })).toEqual({ result: { model, thinkingLevel: 'high' } })
  expect(await defaults(null)).toEqual({
    result: { model: project.model, thinkingLevel: project.thinkingLevel },
  })
  expect((await defaults({ id: 999 })).error).toBe('No conversation #999')

  // Without a choice, the branch keeps its source's configuration and a new root takes the project default.
  const agentOf = async (id: ConversationId) =>
    (await server.harness.conversation(id, context))!.agent(context)
  const branch = (
    await post(server, '/api/extensions/lineage/actions/branch', {
      args: { from: other.id, prompt: 'Follow B', isolated: false },
    })
  ).data.result.id as ConversationId
  expect(await agentOf(branch)).toMatchObject({ model, thinkingLevel: 'high' })
  const root = (
    await post(server, '/api/extensions/lineage/actions/newRoot', {
      args: { prompt: 'Start C', isolated: false },
    })
  ).data.result.id as ConversationId
  expect(await agentOf(root)).toMatchObject({
    model: project.model,
    thinkingLevel: project.thinkingLevel,
  })
  await (await server.harness.conversation(root, context))!.waitForIdle(context)
})

const anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'lineage-test.anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_task, runtime, caller) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        caller,
      ),
  },
  abort: (_task, runtime, caller) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), caller),
})

it('resolves the root per tree for notes, the prompt and compaction', async () => {
  const { server } = await fixture()
  server.host.registry.install(defineExtension({ name: 'lineage-test', tasks: [anchor] }))
  const fork = async (from: ConversationId) => {
    const conversation = (await server.harness.conversation(from, context))!
    const at = await server.harness.commit(
      async (tx) => (await tx.appendEntry(from, { kind: 'test.point', data: {} })).id,
      context,
    )
    return (await conversation.fork(at, { ownership: { kind: 'ownerless' } }, context)).id
  }
  const other = await second(server)
  // ⌘K "Make this a root" adds it; adding again changes nothing.
  for (let n = 0; n < 2; n++)
    expect(
      (await post(server, '/api/extensions/lineage/actions/root', { args: { id: other.id } })).data
        .result,
    ).toEqual({ roots: [1, other.id] })
  const first = await fork(ROOT_CONVERSATION_ID)
  const branch = await fork(other.id)
  const nested = await fork(branch)
  const subagent = await server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: nested,
      background: true,
    })
    return (await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })).id
  }, context)
  const outside = (
    await server.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  ).id
  expect(
    (await post(server, '/api/extensions/lineage/actions/root', { args: { id: subagent } })).status,
  ).not.toBe(200)

  const note = server.host.registry.snapshot().extension('lineage')!.tools![0]
  const send = (from: ConversationId) =>
    note.execute(
      { to: 'root', text: `from ${from}` },
      { conversationId: from } as Parameters<typeof note.execute>[1],
      context,
    )
  for (const from of [first, branch, nested, subagent]) await send(from)
  const notes = async (id: ConversationId) =>
    (await (await server.harness.conversation(id, context))!.context(context)).entries
      .filter((entry) => entry.kind === 'lineage.note')
      .map((entry) => (entry.data as { text: string }).text)
  expect(await notes(ROOT_CONVERSATION_ID)).toEqual([`from ${first}`])
  expect(await notes(other.id)).toEqual([`from ${branch}`, `from ${nested}`, `from ${subagent}`])
  await expect(send(outside)).rejects.toThrow(`#${outside} has no root`)

  expect(await section(server, nested)).toBe(
    `You are #${nested}.\nRoot: #${other.id}.\nZoom out when you need to: read any conversation, a root or a sibling, with codemode \`ultimate.entries(id)\` and \`ultimate.search(text)\`. Leave a \`note\` for a conversation your work affects.`,
  )
  expect(await section(server, outside)).not.toContain('Root:')
  expect(await section(server, subagent)).toBeUndefined()
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: { id: subagent } })).data
      .result,
  ).toEqual({ roots: [1, other.id], root: other.id })
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: { id: outside } })).data
      .result,
  ).toEqual({ roots: [1, other.id] })

  // The branch root compacts with the root focus, its branch with the branch focus.
  for (const id of [other.id, branch])
    await server.harness.commit(async (tx) => {
      for (let n = 0; n < 8; n++)
        await tx.appendEntry(id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
        })
    }, context)
  const compacted = async (id: ConversationId) => {
    const conversation = (await server.harness.conversation(id, context))!
    await server.harness.waitForTask(await conversation.compact(undefined, context), context)
    return textOf((await conversation.context(context)).entries[0].model?.[0]?.content)
  }
  expect(await compacted(other.id)).toContain('LINEAGE SUMMARY of This is a root conversation')
  expect(await compacted(branch)).toContain('LINEAGE SUMMARY of This is a branch')
})
