import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { attach, fauxServer, post, prepareFauxServer, temp, until } from './helpers.ts'
import type { ConversationSummary } from '../shared/protocol.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { actions as conversationActions } from '../extensions/conversations/server.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { actionExec } from '../server/actions.ts'
import { currentAnswer, exchangeUser } from '../extensions/conversations/summary.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

/** A faux server whose project also enables subagents (for an owned child) and surfaces. */
async function launch() {
  const home = await temp('ultimate-conversations-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: { enable: ['subagents', 'surfaces'] },
    }),
  )
  const server = await fauxServer({
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  const summary = (id: number) => server.api.conversations().find((item) => item.id === id)
  return {
    server,
    home,
    summary,
    /** A new top-level conversation, as the sidebar creates one. */
    create: async (data: { cwd?: string; title?: string } = {}) =>
      (await post(server, '/api/conversations', data)).data.id as ConversationId,
    /** A user message at `timestamp`, without a run; resolves once the summary shows it. */
    message: async (id: ConversationId, text: string, timestamp: number) => {
      await server.harness.commit(
        (tx) =>
          tx.appendEntry(id, {
            kind: 'pi.user',
            model: [{ role: 'user', content: text, timestamp }],
          }),
        context,
      )
      await until(() => summary(id)?.inputAt === timestamp)
    },
    /** A section of `extension` as conversation `id` would see it now. */
    render: async (extension: string, id: ConversationId) => {
      const section = server.host.registry.snapshot().extension(extension)!.sections![0]
      const agent = await (await server.harness.conversation(id, context))!.agent(context)
      return section.render(
        { conversationId: id, agent } as unknown as Parameters<typeof section.render>[0],
        context,
      )
    },
    action: (name: string, args: unknown) =>
      post(server, `/api/extensions/conversations/actions/${name}`, { args }),
  }
}
/** The conversation ids a conversations section lists. */
const listed = (text: string | undefined) =>
  [...(text ?? '').matchAll(/^- #(\d+) /gm)].map((match) => Number(match[1]))

it('tells each top-level conversation about the others, and the surface on screen', async () => {
  const { server, home, summary, create, message, render } = await launch()
  const root = ROOT_CONVERSATION_ID
  expect(await render('conversations', root)).toBeUndefined()

  // An owned child (a subagent) is never listed and gets neither section.
  await post(server, '/api/conversations/1/submit', { text: 'delegate to worker' })
  await server.harness.waitForIdle(context)
  const child = server.api.conversations().find((item) => item.label === 'worker')!
  expect(child.inputAt).toEqual(expect.any(Number))
  expect(child.parentConversationId).toBe(root)
  expect(child.branchOf).toBeUndefined()
  expect(await render('conversations', root)).toBeUndefined()
  expect(await render('conversations', child.id as ConversationId)).toBeUndefined()
  expect(await render('surfaces', child.id as ConversationId)).toBeUndefined()

  // Empty conversations, titled or not, are never listed.
  const empty = await create({ title: 'Empty' })
  await create()
  expect(await render('conversations', root)).toBeUndefined()

  const other = await create()
  await message(other, 'Fix the parser', 2000)
  expect(listed(await render('conversations', root))).toEqual([other])
  const seen = await render('conversations', other)
  expect(seen).toMatch(new RegExp(`^You are conversation #${other}\\.`))
  expect(listed(seen)).toEqual([root])
  expect(await render('conversations', empty)).toContain(`- #${other} Fix the parser\n`)

  // A conversation in another directory says where it works.
  const elsewhere = await create({ cwd: home })
  await message(elsewhere, 'Elsewhere', 3000)
  expect(await render('conversations', root)).toContain(
    `- #${elsewhere} Elsewhere (cwd: ${home})\n`,
  )

  // At most the 10 most recently active, by id; concluded ones are left out before the cut.
  const recent: ConversationId[] = []
  for (let index = 0; index < 9; index++) {
    recent.push(await create())
    await message(recent[index], `Recent ${index}`, 4000 + index)
  }
  expect(listed(await render('conversations', root))).toEqual([elsewhere, ...recent])
  await post(server, '/api/extensions/conversations/actions/conclude', {
    args: { ids: [recent[0]] },
  })
  expect(listed(await render('conversations', root))).toEqual([
    other,
    elsewhere,
    ...recent.slice(1),
  ])

  // An ownerless fork is top-level, but its inherited history is tracked separately.
  const view = await server.root.viewState(context)
  const entry = view.value.entries.find((item) => item.kind === 'pi.user')!
  view.dispose()
  const fork = await server.root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  await until(() => summary(fork.id)?.inputAt !== undefined)
  expect(summary(fork.id)!.inputAt).toEqual(expect.any(Number))
  expect(summary(fork.id)).toMatchObject({ branchOf: { conversationId: root, at: entry.id } })
  expect(summary(fork.id)).not.toHaveProperty('parentConversationId')
  const stream = await attach(server)
  try {
    const wire = stream.events.find((event) => event.name === 'conversations')!
    const conversations = wire.data as ConversationSummary[]
    expect(conversations.find((item) => item.id === fork.id)).toMatchObject({
      branchOf: { conversationId: root, at: entry.id },
    })
    expect(conversations.find((item) => item.id === fork.id)).not.toHaveProperty(
      'parentConversationId',
    )
    expect(conversations.find((item) => item.id === child.id)?.parentConversationId).toBe(root)
  } finally {
    await stream.close()
  }
  expect(await render('conversations', fork.id)).toContain(`You are conversation #${fork.id}.`)
  expect(listed(await render('conversations', root))).toContain(fork.id)
  await until(async () => {
    try {
      const manifest = JSON.parse(
        await readFile(join(server.host.home, 'conversations.json'), 'utf8'),
      )
      return manifest.some((item: { id: number }) => item.id === fork.id)
    } catch {
      return false
    }
  })
  const manifest = JSON.parse(await readFile(join(server.host.home, 'conversations.json'), 'utf8'))
  expect(manifest.some((item: { id: number }) => item.id === child.id)).toBe(false)

  // Every top-level conversation gets the surface line.
  for (const id of [root, other, empty, fork.id])
    expect(await render('surfaces', id)).toBe('The user is looking at the Agent surface (agent).')
})

it('renames and clears top-level conversations', async () => {
  const { server, summary, create, message, action } = await launch()
  const id = await create()
  await message(id, 'Fix the parser', 2000)
  const title = async () => (await server.harness.snapshot(Metadata, id, context))?.title

  expect(await action('rename', { id, title: '  Parser work  ' })).toEqual({
    status: 200,
    data: { result: { ok: true } },
  })
  await until(() => summary(id)?.title === 'Parser work')
  await action('rename', { id, title: ' Parser\n\twork\r\n  again ' })
  await until(() => summary(id)?.title === 'Parser work again')
  await action('rename', { id, title: 'x'.repeat(200) })
  await until(() => summary(id)?.title === 'x'.repeat(160))
  await action('rename', { id, title: '   ' })
  await until(() => summary(id)?.title === 'Fix the parser')
  expect(await title()).toBeUndefined()

  // Bad args and conversations that are not top-level are refused.
  const root = server.root
  await message(root.id, 'Root work', 1000)
  const entry = (await root.context(context)).entries.find((item) => item.kind === 'pi.user')!
  const fork = await root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  expect(await action('rename', { id: fork.id, title: 'Branch work' })).toEqual({
    status: 200,
    data: { result: { ok: true } },
  })
  expect(await action('reset', { id: fork.id })).toEqual({
    status: 200,
    data: { result: { ok: true } },
  })
  await post(server, '/api/conversations/1/submit', { text: 'delegate to worker' })
  await server.harness.waitForIdle(context)
  const child = server.api.conversations().find((item) => item.label === 'worker')!
  const owned = `Conversation ${child.id} is owned, not a top-level conversation`
  for (const [name, args, error] of [
    ['rename', null, 'Expected a conversation id'],
    ['rename', { id: 'one', title: 'x' }, 'Expected a conversation id'],
    ['rename', { id }, 'Expected a title'],
    ['rename', { id: 999999, title: 'x' }, 'Unknown conversation 999999'],
    ['rename', { id: child.id, title: 'x' }, owned],
    ['reset', { id: child.id }, owned],
    ['conclude', { ids: [child.id] }, owned],
  ] as const)
    expect(await action(name, args)).toEqual({ status: 500, data: { error } })

  // Clearing starts an empty context and keeps the name the first message gave it.
  const conversation = (await server.harness.conversation(id, context))!
  expect(await action('reset', { id })).toEqual({ status: 200, data: { result: { ok: true } } })
  await until(async () => (await conversation.context(context)).head?.kind === 'pi.reset')
  expect((await conversation.context(context)).entries.map((item) => item.kind)).toEqual([
    'pi.reset',
  ])
  expect(await title()).toBe('Fix the parser')
  await until(() => summary(id)?.title === 'Fix the parser')

  // A working conversation is not cleared.
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  server.host.registry.install(
    defineExtension({
      name: 'conversations-test',
      tools: [
        defineTool({
          name: 'hold_run',
          description: 'Hold the run',
          parameters: Type.Object({}),
          execute: async () => {
            await gate
            return {}
          },
        }),
      ],
    }),
  )
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('hold_run', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ])
  try {
    await post(server, `/api/conversations/${id}/submit`, { text: 'work' })
    await until(() => summary(id)?.busy === true)
    expect(await action('reset', { id })).toEqual({
      status: 500,
      data: { error: `Conversation ${id} is working; stop it before clearing it` },
    })
  } finally {
    release()
  }
  await server.harness.waitForIdle(context)
  // No reset was placed after the run: its message is still in the context.
  expect((await conversation.context(context)).entries.map((item) => item.kind)).toContain(
    'pi.user',
  )
})

it('projects arbitrary typed inputs, ignores user-role writes, and preserves activity across heads and reopen', async () => {
  const { server, summary, create, action } = await launch()
  const id = await create()
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.submit(
    {
      type: 'write',
      entry: {
        kind: 'lineage.note',
        model: [{ role: 'user', content: 'A note, not an input', timestamp: 1000 }],
      },
    },
    context,
  )
  server.harness.resume()
  await server.harness.waitForIdle(context)
  await until(() => summary(id) !== undefined)
  expect(summary(id)).not.toHaveProperty('inputAt')
  expect(summary(id)).not.toHaveProperty('title')

  await conversation.submit(
    { type: 'input', content: '  Typed\n request  ', entry: { kind: 'test.request' } },
    context,
  )
  server.harness.resume()
  await server.harness.waitForIdle(context)
  await until(() => summary(id)?.answerAt !== undefined)
  expect(summary(id)?.title).toBe(' Typed request ')
  const view = await conversation.viewState(context)
  const input = view.value.entries.find((entry) => entry.kind === 'test.request')!
  expect(input.input).toBe(true)
  const answer = view.value.entries.findLast((entry) => entry.model?.[0]?.role === 'assistant')!
  view.dispose()
  const inputAt = input.model![0].timestamp
  const answerAt = answer.model![0].timestamp
  await until(() => summary(id)?.inputAt === inputAt && summary(id)?.answerAt === answerAt)

  // A user-role write after the answer must not invalidate the current exchange or change recency.
  await conversation.submit(
    {
      type: 'write',
      entry: {
        kind: 'lineage.note',
        model: [{ role: 'user', content: 'Later note', timestamp: inputAt + 10000 }],
      },
    },
    context,
  )
  server.harness.resume()
  await server.harness.waitForIdle(context)
  const activity = { inputAt, answerAt }
  expect(summary(id)).toMatchObject(activity)
  await server.harness.commit(async (tx) => {
    expect((await exchangeUser(tx, id))?.id).toBe(input.id)
    expect(await currentAnswer(tx, id, answer.id)).toBe(true)
  }, context)
  await server.harness.commit(
    (tx) => tx.appendEntry(id, { kind: 'pi.compaction', head: 'self' }),
    context,
  )
  await until(() => summary(id)?.title === undefined)
  expect(summary(id)).toMatchObject(activity)

  await action('rename', { id, title: 'Kept title' })
  await until(() => summary(id)?.title === 'Kept title')
  await action('reset', { id })
  expect(summary(id)).toMatchObject({ title: 'Kept title', ...activity })
  const options = {
    ultimateRoot: server.host.ultimateRoot,
    projectRoot: server.host.projectRoot,
    userHome: server.host.userHome,
    home: server.host.home,
  }
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const reopened = await fauxServer(options)
  servers.push(reopened)
  expect(reopened.api.conversations().find((item) => item.id === id)).toMatchObject({
    title: 'Kept title',
    ...activity,
  })
})

it('keeps unmarked Pi input history and makes no metadata writes on an unchanged reopen', async () => {
  const { server, create, message, summary } = await launch()
  const id = await create()
  await message(id, 'Existing parser work', 1000)
  await server.harness.commit(
    (tx) =>
      tx.appendEntry(id, {
        kind: 'pi.assistant',
        model: [{ ...fauxAssistantMessage('Existing answer'), timestamp: 2000 }],
      }),
    context,
  )
  await until(() => summary(id)?.answerAt === 2000)
  expect(summary(id)).toMatchObject({
    title: 'Existing parser work',
    inputAt: 1000,
    answerAt: 2000,
  })
  const options = {
    ultimateRoot: server.host.ultimateRoot,
    projectRoot: server.host.projectRoot,
    userHome: server.host.userHome,
    home: server.host.home,
  }
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  const prepared = await prepareFauxServer(options)
  const metadataWrites: number[] = []
  const open = prepared.host.open.bind(prepared.host)
  let stop: (() => void) | undefined
  prepared.host.open = async (...args) => {
    const opened = await open(...args)
    // Subscribe before extension onOpen callbacks reconcile the stored conversations.
    stop = opened.harness.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === 'document' && change.record.kind === Metadata.definition.kind)
          metadataWrites.push(change.conversationId!)
    })
    return opened
  }
  const reopened = { ...prepared, ...(await prepared.go()) }
  servers.push(reopened)
  expect(reopened.api.conversations().find((item) => item.id === id)).toMatchObject({
    title: 'Existing parser work',
    inputAt: 1000,
    answerAt: 2000,
  })
  expect(metadataWrites).toEqual([])
  stop?.()
})

it('conclude merges concurrent additions, deduplicates ids and returns kept checkouts', async () => {
  const { server, create, action } = await launch()
  const first = await create()
  const second = await create()
  const kept = [{ id: first, uncommitted: 2, unlanded: 1 }]
  const released: number[][] = []
  const host = {
    harness: () => server.harness,
    use: () => ({
      release: async (ids: number[]) => {
        released.push(ids)
        return kept
      },
    }),
  } as unknown as ExtensionHost
  const ctx = {
    host,
    signal: new AbortController().signal,
    exec: actionExec('.', new AbortController().signal),
  }
  const results = await Promise.all([
    conversationActions.conclude({ ids: [first, first] }, ctx),
    conversationActions.conclude({ ids: [second] }, ctx),
  ])
  expect(results[0]).toEqual({ concluded: [first], kept })
  expect(released).toEqual(expect.arrayContaining([[first], [second]]))
  expect((await server.host.uiState(context))['ext.conversations.concluded']).toEqual([
    first,
    second,
  ])
  const rejected = await create()
  expect(await action('conclude', { ids: [rejected, 999999] })).toEqual({
    status: 500,
    data: { error: 'Unknown conversation 999999' },
  })
  expect((await server.host.uiState(context))['ext.conversations.concluded']).toEqual([
    first,
    second,
  ])
  expect(await action('conclude', { ids: ['bad'] })).toEqual({
    status: 500,
    data: { error: 'Expected conversation ids' },
  })
})

it('resume removes concluded ancestors and leaves unrelated ids alone', async () => {
  const { server, create, action } = await launch()
  const parent = await create()
  const unrelated = await create()
  const at = await server.harness.commit(
    async (tx) => (await tx.appendEntry(parent, { kind: 'test.branch', data: {} })).id,
    context,
  )
  const child = await (await server.harness.conversation(parent, context))!.fork(
    at,
    { ownership: { kind: 'ownerless' } },
    context,
  )
  await action('conclude', { ids: [parent, child.id, unrelated] })
  expect(await action('resume', { ids: [child.id] })).toEqual({
    status: 200,
    data: { result: { resumed: [parent, child.id] } },
  })
  expect((await server.host.uiState(context))['ext.conversations.concluded']).toEqual([unrelated])
})
