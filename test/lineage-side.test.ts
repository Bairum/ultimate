import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { defineExtension, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { Summaries, summaryBehavior } from '../extensions/conversations/summary.ts'
import type { SummaryHost } from '../extensions/conversations/summary.ts'
import { abstract, branchOf, rootOf, Roots, Side, Tally } from '../extensions/lineage/server.ts'
import type { LineageService } from '../extensions/lineage/server.ts'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { fauxServer, post, seedTally, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
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

/**
 * A faux server whose provider writes side notes as NOTE, drafts as DRAFT, answers `propose` with a `propose_branch`
 * call and `edit` with an edit call, and echoes everything else; `requests` keeps every conversation request.
 */
async function fixture(reopen?: string) {
  const home = reopen ?? (await temp('ultimate-side-'))
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  await seedTally(server.harness)
  const requests: { system: string; messages: Message[] }[] = []
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    // Conversation requests carry their prompt as sections, single requests as content.
    const system = (
      transcript.messages as {
        role: string
        content: unknown
        sections?: Record<string, string>
      }[]
    )
      .filter((message) => message.role === 'system')
      .map((message) =>
        [textOf(message.content), ...Object.values(message.sections ?? {})].join('\n'),
      )
      .join('\n')
    const messages = transcript.messages.filter(
      (message) => (message as { role: string }).role !== 'system',
    )
    requests.push({ system, messages })
    if (system.startsWith('You write the note')) return fauxAssistantMessage('NOTE: use SQLite.')
    if (system.startsWith('You draft')) return fauxAssistantMessage('DRAFT: build it.')
    const final = transcript.messages.at(-1)!
    if (final.role === 'toolResult') return fauxAssistantMessage(`Tool: ${textOf(final.content)}`)
    const last = textOf(transcript.messages.findLast((message) => message.role === 'user')?.content)
    if (last === 'propose')
      return fauxAssistantMessage([fauxToolCall('propose_branch', { prompt: 'Build the store' })], {
        stopReason: 'toolUse',
      })
    if (last === 'edit')
      return fauxAssistantMessage(
        [fauxToolCall('edit', { path: 'x.txt', oldText: 'a', newText: 'b' })],
        { stopReason: 'toolUse' },
      )
    return fauxAssistantMessage(`echo ${last}`)
  }
  server.host.faux!.setResponses([route])
  return { server, home, requests }
}

async function action(server: Server, name: string, args: Record<string, unknown>) {
  const { status, data } = await post(server, `/api/extensions/lineage/actions/${name}`, { args })
  return { status, error: data.error as string | undefined, result: data.result }
}

/** Root 1 as a tally with one answered branch. */
async function makeTally(server: Server) {
  const branch = await action(server, 'branch', { from: 1, prompt: 'First', isolated: false })
  await settled(server, branch.result.id)
}

/** A tally with a side chat opened on it with `prompt`, answered. */
async function opened(server: Server, prompt = 'Which store?') {
  await makeTally(server)
  return openSide(server, prompt)
}

async function openSide(server: Server, prompt: string) {
  const side = await action(server, 'side', { root: 1, prompt })
  expect(side.error).toBeUndefined()
  const id = side.result.id as ConversationId
  await settled(server, id)
  return id
}

const settled = async (server: Server, id: ConversationId) => {
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.waitForIdle(context)
  return conversation
}

const rootEntries = async (server: Server) =>
  (await server.root.context(context)).entries.map((entry) => [
    entry.kind,
    (entry.data as { source?: string } | undefined)?.source,
  ])

const sides = async (server: Server) =>
  (await server.harness.snapshot(Roots, ROOT_CONVERSATION_ID, context))?.sides ?? {}

it('opens a side chat from the tally’s tip, one at a time, without writing into the tally', async () => {
  const { server, requests } = await fixture()
  await makeTally(server)
  const before = await rootEntries(server)
  const id = await openSide(server, 'Which store?')
  expect(await rootEntries(server)).toEqual(before)
  expect(await sides(server)).toEqual({ 1: id })
  const record = await server.harness.commit((tx) => tx.conversation(id), context)
  const tip = (await server.root.context(context)).entries.at(-1)!.id
  expect(record?.parent).toEqual({ conversationId: 1, at: tip })
  expect(record?.owner).toBeUndefined()
  expect((await server.harness.snapshot(Side, id, context))?.side).toEqual({ root: 1, at: tip })
  const summary = server.api.conversations().find((item) => item.id === id)
  expect([summary?.label, summary?.title, summary?.cwd]).toEqual([
    'side chat',
    'Which store?',
    server.host.projectRoot,
  ])
  // It read the tally, then its prompt once.
  const request = requests.find((item) => textOf(item.messages.at(-1)?.content) === 'Which store?')!
  expect(request.messages.map((message) => textOf(message.content))).toEqual([
    expect.stringMatching(/^#\d+ was started from the tally/),
    'Which store?',
  ])
  expect(request.system).toContain(`You are #${id}, a side chat with #1`)

  const second = await action(server, 'side', { root: 1, prompt: 'Another' })
  expect(second.error).toBe(`#1 already has an open side chat, #${id}`)
  const branch = await action(server, 'side', { root: id, prompt: 'Nested' })
  expect(branch.error).toBe(`#${id} is no tally`)
})

it('gives a side chat every ordinary tool and propose_branch on top', async () => {
  const { server, requests } = await fixture()
  const id = await opened(server)
  const agent = await (await server.harness.conversation(id, context))!.agent(context)
  const offered = agent.tools.map((tool) => tool.name)
  for (const name of ['bash', 'edit', 'write', 'note', 'subagent', 'propose_branch'])
    expect(offered).toContain(name)
  // Elsewhere propose_branch is not offered.
  const root = await server.root.agent(context)
  expect(root.tools.map((tool) => tool.name)).not.toContain('propose_branch')

  const conversation = (await server.harness.conversation(id, context))!
  await conversation.submit({ type: 'input', content: 'propose' }, context)
  await conversation.waitForIdle(context)
  expect(textOf(requests.at(-1)!.messages.at(-1)?.content)).toMatch(/^Proposed\./)
  expect(await action(server, 'sideDraft', { root: 1, side: id })).toMatchObject({
    result: { prompt: 'Build the store' },
  })
})

it('refuses to end or draft for a side chat that is no longer the open one', async () => {
  const { server } = await fixture()
  const stale = await opened(server, 'First chat')
  expect(
    (await action(server, 'endSide', { root: 1, side: stale, mode: 'discard' })).error,
  ).toBeUndefined()
  const open = await openSide(server, 'Second chat')
  // A page still showing the first one ends nothing.
  const error = `Side chat #${stale} is not the open side chat of #1`
  expect((await action(server, 'endSide', { root: 1, side: stale, mode: 'note' })).error).toBe(
    error,
  )
  expect((await action(server, 'sideDraft', { root: 1, side: stale })).error).toBe(error)
  expect(await sides(server)).toEqual({ 1: open })
  expect((await server.harness.snapshot(Side, open, context))?.side).toEqual({
    root: 1,
    at: expect.any(Number),
  })
})

it('gives a branch started from a side chat’s message ordinary tools', async () => {
  const { server } = await fixture()
  const id = await opened(server)
  const at = (await (await server.harness.conversation(id, context))!.context(context)).entries.at(
    -1,
  )!.id
  const branch = await action(server, 'branch', {
    from: id,
    at,
    prompt: 'Build it',
    isolated: false,
  })
  expect(branch.error).toBeUndefined()
  const agent = await (await settled(server, branch.result.id)).agent(context)
  const offered = agent.tools.map((tool) => tool.name)
  for (const name of ['bash', 'edit', 'write', 'note']) expect(offered).toContain(name)
  expect(offered).not.toContain('propose_branch')
})

it('writes no abstract for a side chat’s exchange', async () => {
  const { server } = await fixture()
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
          use: ((name: string) =>
            name === 'lineage'
              ? ({
                  rootOf: (id: number, ctx: typeof context) =>
                    rootOf({ harness: () => server.harness }, id, ctx),
                  branchOf: (id: number, ctx: typeof context) =>
                    branchOf({ harness: () => server.harness }, id, ctx),
                  abstract,
                } satisfies Pick<LineageService, 'rootOf' | 'branchOf' | 'abstract'>)
              : undefined) as NonNullable<SummaryHost['use']>,
        },
        async () => ({
          assessment: 'done',
          activity: 'Talked it through.',
          title: 'Summarized',
          summary: 'Talked it through.',
          abstract: 'Ask: x\nDiverged: none',
        }),
      ),
    }),
  )
  const id = await opened(server)
  await until(
    async () =>
      (await server.harness.snapshot(Summaries, id, context))?.generatedTitle === 'Summarized',
  )
  expect(await branchOf({ harness: () => server.harness }, id, context)).toBeUndefined()
  // A direct write is refused too.
  await server.harness.commit((tx) => abstract(tx, id, { text: 'nope', at: 1 }), context)
  const tally = await server.harness.snapshot(Tally, ROOT_CONVERSATION_ID, context)
  expect(Object.keys(tally?.abstracts ?? {})).not.toContain(String(id))
  expect(
    (await server.root.context(context)).entries.filter(
      (entry) => (entry.data as { conversation?: number } | undefined)?.conversation === id,
    ),
  ).toEqual([])
})

it('ends a side chat as a note: one model-visible note in the tally, then read-only', async () => {
  const { server, requests } = await fixture()
  const id = await opened(server)
  const before = await rootEntries(server)
  const ended = await action(server, 'endSide', { root: 1, side: id, mode: 'note' })
  expect(ended.error).toBeUndefined()
  expect(await rootEntries(server)).toEqual([...before, ['lineage.note', 'side']])
  const note = (await server.root.context(context)).entries.at(-1)!
  expect(note.data).toEqual({ text: 'NOTE: use SQLite.', from: id, source: 'side' })
  expect(textOf(note.model?.[0]?.content)).toBe(`Side chat #${id}: NOTE: use SQLite.`)
  // The note asked about the side chat's own messages, not the tally it inherited.
  const asked = requests.find((item) => item.system.startsWith('You write the note'))!
  expect(textOf(asked.messages[0].content)).toContain('[User]: Which store?')
  expect(textOf(asked.messages[0].content)).not.toContain('was started from the tally')
  expect(await sides(server)).toEqual({})
  expect((await server.harness.snapshot(Side, id, context))?.side?.ended).toBe('note')
  const conversation = (await server.harness.conversation(id, context))!
  await expect(conversation.submit({ type: 'input', content: 'More' }, context)).rejects.toThrow(
    `Side chat #${id} has ended and takes no input`,
  )
  expect((await action(server, 'endSide', { root: 1, side: id, mode: 'note' })).error).toBe(
    '#1 has no open side chat',
  )
  // The root can open the next one.
  expect((await action(server, 'side', { root: 1, prompt: 'Next' })).error).toBeUndefined()
})

it('ends a side chat in a branch that starts from the tally after its note', async () => {
  const { server, requests } = await fixture()
  const id = await opened(server)
  expect(
    (await action(server, 'endSide', { root: 1, side: id, mode: 'branch', prompt: ' ' })).error,
  ).toBe('A branch needs a prompt')
  const ended = await action(server, 'endSide', {
    root: 1,
    side: id,
    mode: 'branch',
    prompt: 'Build the store',
    isolated: false,
  })
  expect(ended.error).toBeUndefined()
  const branch = ended.result.id as ConversationId
  await settled(server, branch)
  const entries = (await server.root.context(context)).entries
  const [note, node] = entries.slice(-2)
  expect([note.kind, (note.data as { source: string }).source]).toEqual(['lineage.note', 'side'])
  expect(node.kind).toBe('lineage.branched')
  expect(node.data).toEqual({ branch, at: note.id, intent: 'Build the store', side: id })
  expect(textOf(node.model?.[0]?.content)).toBe(
    `#${branch} was started from the tally (#1/${note.id}), ending side chat #${id}, with the prompt:\nBuild the store`,
  )
  // Its first request reads the tally up to the note, then its prompt.
  const request = requests.find(
    (item) => textOf(item.messages.at(-1)?.content) === 'Build the store',
  )!
  expect(request.messages.slice(-2).map((message) => textOf(message.content))).toEqual([
    `Side chat #${id}: NOTE: use SQLite.`,
    'Build the store',
  ])
  expect(await sides(server)).toEqual({})
  expect((await server.harness.snapshot(Side, id, context))?.side).toMatchObject({
    ended: 'branch',
    branch,
  })
})

it('discards a side chat without touching the tally', async () => {
  const { server } = await fixture()
  const id = await opened(server)
  const before = await rootEntries(server)
  expect(
    (await action(server, 'endSide', { root: 1, side: id, mode: 'discard' })).error,
  ).toBeUndefined()
  expect(await rootEntries(server)).toEqual(before)
  expect(await sides(server)).toEqual({})
  expect((await server.harness.snapshot(Side, id, context))?.side?.ended).toBe('discard')
  // It stays stored.
  expect(
    (await (await server.harness.conversation(id, context))!.context(context)).entries.length,
  ).toBeGreaterThan(0)
})

it('refuses to end a side chat while it answers', async () => {
  const { server } = await fixture()
  const id = await opened(server)
  const conversation = (await server.harness.conversation(id, context))!
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  server.host.faux!.setResponses([
    async () => {
      await held
      return fauxAssistantMessage('Done.')
    },
  ])
  await conversation.submit({ type: 'input', content: 'Think' }, context)
  expect((await action(server, 'endSide', { root: 1, side: id, mode: 'note' })).error).toBe(
    `Side chat #${id} is still answering`,
  )
  release()
  await conversation.waitForIdle(context)
})

it('writes a side chat’s note and branch once across a restart', async () => {
  const { server, home, requests } = await fixture()
  const id = await opened(server)
  // The branch step waits for the process to stop, as if it went down right after the note.
  const lineage = server.host.registry.snapshot().extension('lineage')!
  const task = lineage.tasks!.find((candidate) => candidate.definition.name === 'lineage.side')!
  const stalled = defineTask({
    ...task.definition,
    phases: {
      ...task.definition.phases,
      branch: (_task, runtime) =>
        new Promise((_resolve, reject) => {
          runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason as Error))
        }),
    },
  } as Parameters<typeof defineTask>[0])
  server.host.registry.install(
    defineExtension({
      ...lineage,
      tasks: [...lineage.tasks!.filter((candidate) => candidate !== task), stalled],
    }),
  )
  const ending = action(server, 'endSide', {
    root: 1,
    side: id,
    mode: 'branch',
    prompt: 'Build the store',
    isolated: false,
  }).catch(
    // The request ends with the process that served it.
    () => undefined,
  )
  await until(async () =>
    (await server.root.context(context)).entries.some(
      (entry) => (entry.data as { source?: string } | undefined)?.source === 'side',
    ),
  )
  await server.close()
  servers.splice(servers.indexOf(server), 1)
  await ending

  const reopened = await fixture(home)
  await until(
    async () =>
      (await reopened.server.harness.snapshot(Side, id, context))?.side?.ended === 'branch',
  )
  const branch = (await reopened.server.harness.snapshot(Side, id, context))!.side!
    .branch! as ConversationId
  await settled(reopened.server, branch)
  const kinds = (await reopened.server.root.context(context)).entries
    .slice(-2)
    .map((entry) => [
      entry.kind,
      (entry.data as { source?: string; side?: number }).source ??
        (entry.data as { side?: number }).side,
    ])
  expect(kinds).toEqual([
    ['lineage.note', 'side'],
    ['lineage.branched', id],
  ])
  expect(
    (await reopened.server.root.context(context)).entries.filter(
      (entry) => (entry.data as { source?: string } | undefined)?.source === 'side',
    ),
  ).toHaveLength(1)
  // The note was asked once, before the restart.
  expect(
    [...requests, ...reopened.requests].filter((item) =>
      item.system.startsWith('You write the note'),
    ),
  ).toHaveLength(1)
  expect(await sides(reopened.server)).toEqual({})
})
