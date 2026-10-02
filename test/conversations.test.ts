import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { fauxServer, post, temp, until } from './helpers.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'

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
    JSON.stringify({ extensions: { enable: ['subagents', 'surfaces'] } }),
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
  await post(server, '/api/conversations/1/submit', { text: 'delegate to scout' })
  await server.harness.waitForIdle(context)
  const child = server.api.conversations().find((item) => item.label === 'scout')!
  expect(child.inputAt).toEqual(expect.any(Number))
  expect(await render('conversations', root)).toBeUndefined()
  expect(await render('conversations', child.id as ConversationId)).toBeUndefined()
  expect(await render('surfaces', child.id as ConversationId)).toBeUndefined()

  // Empty conversations, titled or not, are never listed.
  const empty = await create({ title: 'Empty' })
  await create()
  expect(await render('conversations', root)).toBeUndefined()

  const other = await create()
  await message(other, 'Fix the parser', 2000)
  expect(await render('conversations', root)).toBe(
    `You are conversation #1. Other conversations in this project, each a separate agent with its own context:
- #${other} Fix the parser

They work in the same checkout unless a cwd says otherwise: check \`git status\` before broad changes, never revert or reformat changes you did not make, and coordinate through the user. In codemode, \`ultimate.entries(id)\` shows what another conversation did and \`ultimate.taskGraph()\` whether it is working.`,
  )
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

  // At most the 10 most recently active, by id; archived ones are left out before the cut.
  const recent: ConversationId[] = []
  for (let index = 0; index < 9; index++) {
    recent.push(await create())
    await message(recent[index], `Recent ${index}`, 4000 + index)
  }
  expect(listed(await render('conversations', root))).toEqual([elsewhere, ...recent])
  await post(server, '/api/ui', { set: { 'ext.conversations.archived': [recent[0]] } })
  expect(listed(await render('conversations', root))).toEqual([
    other,
    elsewhere,
    ...recent.slice(1),
  ])

  // A fork is not top-level: it gets neither section and is not listed.
  const view = await server.root.viewState(context)
  const entry = view.value.entries.find((item) => item.kind === 'pi.user')!
  view.dispose()
  const fork = await server.root.fork(entry.id, { ownership: { kind: 'ownerless' } }, context)
  await until(() => summary(fork.id) !== undefined)
  expect(summary(fork.id)!.inputAt).toEqual(expect.any(Number))
  expect(await render('conversations', fork.id)).toBeUndefined()
  expect(await render('surfaces', fork.id)).toBeUndefined()
  expect(listed(await render('conversations', root))).not.toContain(fork.id)

  // Every top-level conversation gets the surface line.
  for (const id of [root, other, empty])
    expect(await render('surfaces', id)).toBe('The user is looking at the Agent surface (agent).')
}, 60000)

it('adds the section to a running conversation as one patch, not a re-sent prompt', async () => {
  const { server, create, message } = await launch()
  const systemEntries = async () =>
    (await server.root.context(context)).entries.filter((entry) => entry.kind === 'pi.system')
  await post(server, '/api/conversations/1/submit', { text: 'Return the word SCOUT.' })
  await server.harness.waitForIdle(context)
  const before = await systemEntries()
  expect(before.length).toBeGreaterThan(0)
  expect(
    before.some((entry) => {
      const system = entry.model?.[0]
      return system?.role === 'system' && system.sections?.conversations !== undefined
    }),
  ).toBe(false)

  const other = await create()
  await message(other, 'Fix the parser', Date.now())
  await post(server, '/api/conversations/1/submit', { text: 'Return the word SCOUT.' })
  await server.harness.waitForIdle(context)
  const added = (await systemEntries()).slice(before.length)
  expect(added.map((entry) => entry.model)).toEqual([
    [
      {
        role: 'system',
        content: '',
        sections: {
          conversations: expect.stringContaining(`\n- #${other} Fix the parser\n`),
        },
        timestamp: expect.any(Number),
      },
    ],
  ])
}, 60000)

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
  const forked = `Conversation ${fork.id} is a subagent or a fork, not a top-level conversation`
  for (const [name, args, error] of [
    ['rename', null, 'Expected a conversation id'],
    ['rename', { id: 'one', title: 'x' }, 'Expected a conversation id'],
    ['rename', { id }, 'Expected a title'],
    ['rename', { id: 999999, title: 'x' }, 'Unknown conversation 999999'],
    ['rename', { id: fork.id, title: 'x' }, forked],
    ['reset', { id: fork.id }, forked],
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
}, 60000)
