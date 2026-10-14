import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { Branch, leaveNote } from '../extensions/lineage/server.ts'
import { Seen } from '../extensions/lineage/catchup.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { HistoryResponse } from '../shared/protocol.ts'
import { fauxServer, post, temp, until } from './helpers.ts'

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
async function fixture() {
  const home = await temp('ultimate-lineage-')
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome: home })
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
  return { server, briefs, failures }
}

it('branches with a brief, marks the source, and keeps inherited history reachable', async () => {
  const { server, briefs } = await fixture()
  await (
    await server.root.submit(
      { type: 'input', content: 'We build a tree of conversations.' },
      context,
    )
  ).wait(context)
  const { messages: seen } = await server.root.context(context)
  const answer = (await server.root.entries({}, 1, undefined, context)).items[0].id
  const { status, data } = await post(server, '/api/extensions/lineage/actions/branch', {
    args: { prompt: 'Add notes between conversations' },
  })
  expect(status).toBe(200)
  const id = data.result.id as ConversationId
  const branch = (await server.harness.conversation(id, context))!
  await until(
    async () => (await server.harness.snapshot(Branch, id, context))?.branch?.status === 'ready',
  )
  await branch.waitForIdle(context)

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
    /^You are the root of this project \(#1\): you hold its idea and keep the tally of what lands\./,
  )
  expect(await section(server, id)).toContain(
    `You are #${id}, branched from #1 at entry ${at} for: Add notes between conversations\nRoot: #1.`,
  )

  // Making the branch the root moves the root line to it.
  await post(server, '/api/extensions/lineage/actions/root', { args: { id } })
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: null })).data.result,
  ).toEqual({ root: id })
  expect(await section(server, id)).toMatch(
    new RegExp(`^You are the root of this project \\(#${id}\\)`),
  )
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
    await post(server, '/api/extensions/lineage/actions/branch', { args: { prompt: 'Try it' } })
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
      args: { prompt: 'Fix the lost answers' },
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
    'LINEAGE SUMMARY of This is the root conversation',
  )
})

/** A faux server where `NOTIFY {json}` calls the notify tool and `HOLD` answers only once released. */
async function notifyFixture(reopen?: string) {
  const home = reopen ?? (await temp('ultimate-lineage-'))
  const server = await fauxServer({ ultimateRoot: resolve('.'), home, userHome: home })
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

const repoGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_COUNT: '0' } })
    .toString()
    .trim()

async function catchupFixture() {
  const home = await temp('ultimate-lineage-main-')
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot)
  repoGit(projectRoot, 'init', '-b', 'main')
  repoGit(projectRoot, 'config', 'user.email', 'test@example.com')
  repoGit(projectRoot, 'config', 'user.name', 'Test')
  await writeFile(join(projectRoot, 'schema.ts'), 'base\n')
  repoGit(projectRoot, 'add', '.')
  repoGit(projectRoot, 'commit', '-m', 'base')
  const config = { ultimateRoot: resolve('.'), home, userHome: home, projectRoot }
  const requests: string[][] = []
  const gate = Promise.withResolvers<void>()
  let held = false
  const open = async () => {
    const server = await fauxServer(config)
    servers.push(server)
    const route: FauxResponseFactory = async (transcript, options) => {
      server.host.faux!.appendResponses([route])
      requests.push(
        transcript.messages
          .filter((message) => message.role === 'user')
          .map((message) => textOf(message.content)),
      )
      const last = transcript.messages.at(-1)!
      const text = textOf(last.content)
      if (last.role === 'user' && text === 'edit schema')
        return fauxAssistantMessage(
          [fauxToolCall('write', { path: join(projectRoot, 'schema.ts'), content: 'own edit\n' })],
          { stopReason: 'toolUse' },
        )
      if (
        (last.role === 'toolResult' && text.includes('schema.ts')) ||
        (last.role === 'user' && text === 'resume during restart')
      ) {
        held = true
        await Promise.race([
          gate.promise,
          new Promise((_, fail) =>
            options?.signal?.addEventListener('abort', () => fail(new Error('closed'))),
          ),
        ])
      }
      return fauxAssistantMessage(`echo ${text}`)
    }
    server.host.faux!.setResponses([route])
    return server
  }
  const server = await open()
  return { server, projectRoot, requests, open, release: () => gate.resolve(), held: () => held }
}

it('catches up once on an idle resume, puts overlap first, and reads it before the input', async () => {
  const f = await catchupFixture()
  const seen = await f.server.harness.snapshot(Seen, ROOT_CONVERSATION_ID, context)
  expect(seen?.main).toBe(repoGit(f.projectRoot, 'rev-parse', 'main'))
  const editing = ask(f.server, ROOT_CONVERSATION_ID, 'edit schema')
  await until(f.held)
  f.release()
  await editing
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Fix schema\n\nUltimate-Conversation: 1')
  await writeFile(join(f.projectRoot, 'other.ts'), 'other\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Add something unrelated')
  await ask(f.server, ROOT_CONVERSATION_ID, 'continue work')
  const notes = (await f.server.root.context(context)).entries.filter(
    (entry) =>
      entry.kind === 'lineage.note' && (entry.data as { source?: string }).source === 'main',
  )
  expect(notes).toHaveLength(1)
  const text = (notes[0].data as { text: string }).text
  expect(text).toContain('2 commits landed on main')
  expect(text).toMatch(/\*\*Overlap\*\* .*Fix schema · #1 edit schema/)
  expect(text).toContain('`schema.ts`')
  expect(text.indexOf('Fix schema')).toBeLessThan(text.indexOf('Add something unrelated'))
  expect(f.requests.at(-1)!.slice(-2)).toEqual([text, 'continue work'])
  const view = await f.server.root.context(context)
  expect(
    view.messages
      .filter((message) => message.role === 'user')
      .map((message) => textOf(message.content))
      .slice(-2),
  ).toEqual([text, 'continue work'])
  expect(view.entries.findLastIndex((entry) => entry.kind === 'pi.assistant')).toBeGreaterThan(
    view.entries.indexOf(notes[0]),
  )
  expect((await f.server.harness.snapshot(Seen, ROOT_CONVERSATION_ID, context))?.main).toBe(
    repoGit(f.projectRoot, 'rev-parse', 'main'),
  )
  await ask(f.server, ROOT_CONVERSATION_ID, 'continue again')
  expect(
    (await f.server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)

  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  const reopened = await f.open()
  await ask(reopened, ROOT_CONVERSATION_ID, 'after restart')
  expect(
    (await reopened.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)
  expect(f.requests.at(-1)!.filter((message) => message === text)).toHaveLength(1)
})

it('does not catch up when a note and new commits arrive in the middle of a run', async () => {
  const f = await catchupFixture()
  const run = ask(f.server, ROOT_CONVERSATION_ID, 'edit schema')
  await until(f.held)
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Landed during work')
  await leaveNote(
    { harness: () => f.server.harness },
    ROOT_CONVERSATION_ID,
    'A sibling left a note.',
    { from: 2 },
  )
  f.release()
  await run
  let view = await f.server.root.context(context)
  expect(
    view.entries
      .filter((entry) => entry.kind === 'lineage.note')
      .map((entry) => (entry.data as { source?: string }).source),
  ).toEqual([undefined])
  await ask(f.server, ROOT_CONVERSATION_ID, 'resume after idle')
  view = await f.server.root.context(context)
  expect(
    view.entries.filter(
      (entry) =>
        entry.kind === 'lineage.note' && (entry.data as { source?: string }).source === 'main',
    ),
  ).toHaveLength(1)
})

it('keeps a catch-up exactly once when reopened during the first request', async () => {
  const f = await catchupFixture()
  await ask(f.server, ROOT_CONVERSATION_ID, 'first work')
  await writeFile(join(f.projectRoot, 'schema.ts'), 'landed\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Land schema')
  const interrupted = ask(f.server, ROOT_CONVERSATION_ID, 'resume during restart').catch(
    () => undefined,
  )
  await until(f.held)
  expect(
    (await f.server.root.context(context)).entries.filter((entry) => entry.kind === 'lineage.note'),
  ).toHaveLength(1)
  await f.server.close()
  servers.splice(servers.indexOf(f.server), 1)
  await interrupted
  const reopened = await f.open()
  f.release()
  await reopened.root.waitForIdle(context)
  const view = await reopened.root.context(context)
  const notes = view.entries.filter((entry) => entry.kind === 'lineage.note')
  expect(notes).toHaveLength(1)
  expect(f.requests.at(-1)!.slice(-2)).toEqual([
    (notes[0].data as { text: string }).text,
    'resume during restart',
  ])
})

it('warns an isolated workspace it is behind, prioritizes old overlaps, and caps the rows at 30', async () => {
  const f = await catchupFixture()
  await ask(f.server, ROOT_CONVERSATION_ID, 'An idea')
  const { id } = (
    await post(f.server, '/api/extensions/lineage/actions/branch', {
      args: { prompt: 'Branch task', isolated: true },
    })
  ).data.result as { id: ConversationId }
  const branch = (await f.server.harness.conversation(id, context))!
  await until(
    async () => (await f.server.harness.snapshot(Branch, id, context))?.branch?.status === 'ready',
  )
  await branch.waitForIdle(context)
  const workspace = (await branch.agent(context)).cwd!
  await writeFile(join(workspace, 'schema.ts'), 'own workspace change\n')
  await writeFile(join(f.projectRoot, 'schema.ts'), 'overlapping landing\n')
  repoGit(f.projectRoot, 'add', '.')
  repoGit(f.projectRoot, 'commit', '-m', 'Old overlap')
  for (let i = 0; i < 31; i++) repoGit(f.projectRoot, 'commit', '--allow-empty', '-m', `Other ${i}`)
  await ask(f.server, id, 'Continue branch')
  const notes = (await branch.context(context)).entries.filter(
    (entry) => entry.conversationId === id && entry.kind === 'lineage.note',
  )
  expect(notes).toHaveLength(1)
  const text = (notes[0].data as { text: string }).text
  expect(text).toContain('32 commits landed on main')
  expect(text.split('\n\n')[1]).toMatch(/^- \*\*Overlap\*\* .*Old overlap.*schema.ts/)
  expect(text.split('\n\n').filter((row) => row.startsWith('- '))).toHaveLength(30)
  expect(text).toContain('and 2 more')
  expect(text).toContain('Your workspace is 32 commits behind main; merge it before continuing.')
})
