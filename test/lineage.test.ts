import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, beforeAll, expect, it } from 'vitest'
import {
  abstract,
  Branch,
  branchOf,
  leaveNote,
  rootOf,
  Roots,
  Tally,
} from '../extensions/lineage/server.ts'
import type { LineageService } from '../extensions/lineage/server.ts'
import { Plan } from '../extensions/plan/server.ts'
import { Summaries, summaryBehavior } from '../extensions/conversations/summary.ts'
import type { SummaryHost } from '../extensions/conversations/summary.ts'
import { defineExtension, defineTask } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import type { HistoryResponse } from '../shared/protocol.ts'
import { fauxServer, post, seedTally, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({
      summaryModel: 'unavailable/test',
      extensions: { enable: ['plan', 'subagents'] },
    }),
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

/**
 * A faux server whose provider answers lineage summaries with LINEAGE SUMMARY and everything else with the last user
 * text echoed; `requests` keeps every conversation request's messages.
 */
async function fixture(reopen?: string) {
  const home = reopen ?? (await temp('ultimate-lineage-'))
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const requests: Message[][] = []
  const condensed: string[] = []
  /** While `condense` is set, compaction summaries wait for it. */
  const gate: { condense?: Promise<void> } = {}
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const [system, first] = transcript.messages
    if (textOf(system.content).startsWith('You condense')) {
      condensed.push(textOf(first.content))
      await gate.condense
      return fauxAssistantMessage(`LINEAGE SUMMARY of ${textOf(first.content).slice(0, 40)}`)
    }
    requests.push([...transcript.messages])
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
  return { server, home, requests, condensed, gate }
}

const branchFrom = async (server: Server, args: Record<string, unknown>) => {
  // An empty first conversation is a root that read nothing yet; one with history stays an ordinary root.
  if (args.from === 1) await seedTally(server.harness)
  const { status, data } = await post(server, '/api/extensions/lineage/actions/branch', { args })
  expect([status, data.error]).toEqual([200, undefined])
  return data.result.id as ConversationId
}

/** Wait until `id`'s prompt is delivered and answered. */
const settled = async (server: Server, id: ConversationId) => {
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.waitForIdle(context)
  return conversation
}

/** The model's view of a conversation as [role, text] pairs, system messages left out. */
const said = (messages: readonly Message[]) =>
  messages
    .filter((message) => message.role !== 'system')
    .map((message) => [message.role, textOf(message.content)])

const tallyTokens = async (server: Server, id: ConversationId) =>
  (await (await server.harness.conversation(id, context))!.context(context)).messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  )

const image = { type: 'image', data: 'aW1n', mimeType: 'image/png' } as const

it('branches from a tally: the root gets the prompt node, the branch starts from the tally and its prompt', async () => {
  const { server, requests } = await fixture()
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Plan, server.root.id)).epics.E1 = {
      key: 'E1',
      title: 'Root work',
      body: 'Body',
      status: 'in_progress',
      tasks: {},
    }
  }, context)
  const publications: import('@earendil-works/pi-durable').CommitPublication[] = []
  const stop = server.harness.subscribeCommits((publication) => publications.push(publication))
  const first = await branchFrom(server, { from: 1, prompt: 'Add notes between conversations' })
  stop()
  const creation = publications.find((publication) =>
    publication.changes.some(
      (change) => change.type === 'conversation' && change.value.id === first,
    ),
  )!
  const initialized = (kind: string) =>
    creation.changes.find(
      (change) =>
        change.type === 'document' &&
        change.conversationId === first &&
        change.record.kind === kind,
    )
  expect(initialized(Metadata.definition.kind)).toMatchObject({
    value: { title: 'Add notes between conversations' },
  })
  expect(initialized(Summaries.definition.kind)).toMatchObject({
    value: { generatedTitle: 'Add notes between conversations' },
  })
  expect(initialized(Plan.definition.kind)).toMatchObject({ value: { next: 1, epics: {} } })
  await settled(server, first)
  // A branch starts with an empty plan; the root keeps its own.
  expect((await server.harness.snapshot(Plan, first, context))?.epics).toEqual({})
  expect(
    Object.keys((await server.harness.snapshot(Plan, server.root.id, context))!.epics),
  ).toEqual(['E1'])

  // The empty root became a tally at the reset its first branch forked from.
  const tally = await server.root.context(context)
  const [reset, node] = tally.entries
  expect(reset.kind).toBe('pi.reset')
  expect((await server.harness.snapshot(Tally, server.root.id, context))?.since).toBe(reset.id)
  expect(node.kind).toBe('lineage.branched')
  expect(node.data).toEqual({
    branch: first,
    at: reset.id,
    intent: 'Add notes between conversations',
  })
  expect(said(tally.messages)).toEqual([
    [
      'user',
      `#${first} was started from the tally (#1/${reset.id}) with the prompt:\nAdd notes between conversations`,
    ],
  ])
  // The first branch reads its prompt once, as its own input, with no brief.
  const view = await (await server.harness.conversation(first, context))!.context(context)
  expect(view.entries.map((entry) => entry.kind)).not.toContain('lineage.branched')
  expect(view.entries.filter((entry) => entry.kind === 'pi.reset')).toEqual([reset])
  expect(said(view.messages)).toEqual([
    ['user', 'Add notes between conversations'],
    ['assistant', 'echo Add notes between conversations'],
  ])
  expect((await server.harness.snapshot(Branch, first, context))?.branch).toEqual({
    from: 1,
    at: reset.id,
    intent: 'Add notes between conversations',
  })

  // The next branch starts from the tally's tip: its first request is the tally, then its prompt with the image.
  const later = await branchFrom(server, {
    from: 1,
    prompt: 'Look at this',
    images: [{ data: image.data, mimeType: image.mimeType }],
  })
  await settled(server, later)
  const request = requests.find(
    (messages) =>
      textOf(messages.findLast((message) => message.role === 'user')?.content) === 'Look at this',
  )!
  expect(said(request)).toEqual([
    [
      'user',
      `#${first} was started from the tally (#1/${reset.id}) with the prompt:\nAdd notes between conversations`,
    ],
    ['user', 'Look at this'],
  ])
  expect(request.at(-1)!.content).toEqual([{ type: 'text', text: 'Look at this' }, image])
  const nodes = (await server.root.context(context)).entries.filter(
    (entry) => entry.kind === 'lineage.branched',
  )
  expect(nodes.map((entry) => entry.data)).toEqual([
    { branch: first, at: reset.id, intent: 'Add notes between conversations' },
    { branch: later, at: node.id, intent: 'Look at this', images: 1 },
  ])
  expect(textOf(nodes[1].model?.[0]?.content)).toBe(
    `#${later} was started from the tally (#1/${node.id}) with the prompt:\nLook at this\n(1 image, in #${later})`,
  )
  // Images are counted in the tally, never copied into it.
  expect(JSON.stringify(nodes[1])).not.toContain(image.data)
  await until(
    async () =>
      (await server.harness.snapshot(Tally, server.root.id, context))?.tokens ===
      (await tallyTokens(server, server.root.id)),
  )

  // History pages from the branch back into the entries it inherited.
  const history = (await (
    await fetch(
      `${server.url}/api/conversations/${later}/history?before=${view.entries.at(-1)!.id}`,
    )
  ).json()) as HistoryResponse
  expect(
    history.entries.some(
      (entry: EntryRecord) => entry.conversationId === ROOT_CONVERSATION_ID && entry.id === node.id,
    ),
  ).toBe(true)

  // A tally gets no prompt section, since it never requests; a branch learns where its context starts.
  expect(await section(server, ROOT_CONVERSATION_ID)).toBeUndefined()
  expect(await section(server, first)).toContain(
    `You are #${first}, branched from #1 at entry ${reset.id} for: Add notes between conversations\nRoot: #1.\nYour context starts with the tally of your tree`,
  )
  expect(
    (await post(server, '/api/extensions/lineage/actions/info', { args: { id: first } })).data
      .result,
  ).toMatchObject({
    roots: [1],
    root: 1,
    branch: { from: 1, intent: 'Add notes between conversations' },
  })
})

it('writes the prompt node of a branch of a branch into the tree root and marks its source', async () => {
  const { server, requests } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'First line' })
  await settled(server, first)
  const answer = (
    await (await server.harness.conversation(first, context))!.context(context)
  ).entries.at(-1)!
  const nested = await branchFrom(server, { from: first, prompt: 'Go deeper' })
  await settled(server, nested)

  const root = await server.root.context(context)
  const node = root.entries.at(-1)!
  expect(node.data).toEqual({ branch: nested, at: answer.id, intent: 'Go deeper', from: first })
  expect(textOf(node.model?.[0]?.content)).toBe(
    `#${nested} was started from #${first}/${answer.id} with the prompt:\nGo deeper`,
  )
  // The source keeps a display-only marker; its model never sees it.
  const source = await (await server.harness.conversation(first, context))!.context(context)
  const marker = source.entries.at(-1)!
  expect(marker.kind).toBe('lineage.branched')
  expect(marker.model).toBeUndefined()
  expect(marker.data).toEqual({ branch: nested, at: answer.id, intent: 'Go deeper' })
  // The nested branch reads its source as it was at the fork (which forked before its own node), then its prompt once.
  const request = requests.find(
    (messages) =>
      textOf(messages.findLast((message) => message.role === 'user')?.content) === 'Go deeper',
  )!
  expect(said(request).map(([, text]) => text)).toEqual([
    'First line',
    'echo First line',
    'Go deeper',
  ])
  expect(await section(server, nested)).toContain(
    `You are #${nested}, branched from #${first} at entry ${answer.id} for: Go deeper\nRoot: #1.`,
  )
})

it('refuses inputs in a tally and keeps notes as writes', async () => {
  const { server } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Start' })
  await settled(server, first)
  await expect(server.root.submit({ type: 'input', content: 'Run here' }, context)).rejects.toThrow(
    '#1 is a tally and runs no turns; ask @ultimate to start a branch',
  )
  const refused = await post(server, '/api/conversations/1/submit', { text: 'Run here' })
  expect(refused.status).not.toBe(200)
  const note = server.host.registry.snapshot().extension('lineage')!.tools![0]
  await note.execute(
    { to: 'root', text: 'Landed something.' },
    { conversationId: first } as Parameters<typeof note.execute>[1],
    context,
  )
  const view = await server.root.context(context)
  expect(view.entries.map((entry) => entry.kind)).toEqual([
    'pi.reset',
    'lineage.branched',
    'lineage.note',
  ])
  expect(
    (await server.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run,
  ).toBeUndefined()
  // The note changed the tally's context, so its count follows.
  await until(
    async () =>
      (await server.harness.snapshot(Tally, server.root.id, context))?.tokens ===
      (await tallyTokens(server, server.root.id)),
  )
})

it('updates an open abstract in place and freezes it into a landing', async () => {
  const { server } = await fixture()
  server.host.registry.install(defineExtension({ name: 'lineage-test', tasks: [anchor] }))
  const lineage = {
    branchOf: (id: number, ctx: typeof context) =>
      branchOf({ harness: () => server.harness }, id, ctx),
    abstract,
  }
  const first = await branchFrom(server, { from: 1, prompt: 'Abstract me' })
  await settled(server, first)
  const at = (
    await (await server.harness.conversation(first, context))!.context(context)
  ).entries.at(-1)!.id
  expect(await lineage.branchOf(first, context)).toEqual({ root: 1, intent: 'Abstract me' })
  const write = (id: number, text: string) =>
    server.harness.commit(
      (tx) => lineage.abstract(tx, id, { text, at, title: 'Abstracts', feature: 'Tally' }),
      context,
    )
  const other = await branchFrom(server, { from: 1, prompt: 'Other' })
  await settled(server, other)
  await write(first, 'Ask: one. State: started.')
  await write(other, 'Ask: two. State: started.')
  await write(first, 'Ask: one. State: done.')
  const view = await server.root.context(context)
  const abstracts = view.entries.filter((entry) => entry.kind === 'lineage.abstract')
  const fields = { at, title: 'Abstracts', feature: 'Tally' }
  expect(abstracts.map(({ data, model, edits }) => ({ data, model: !!model, edits }))).toEqual([
    { data: { conversation: first, text: 'Ask: one. State: started.', ...fields }, model: true },
    { data: { conversation: other, text: 'Ask: two. State: started.', ...fields }, model: true },
    {
      data: {
        conversation: first,
        text: 'Ask: one. State: done.',
        anchor: abstracts[0].id,
        ...fields,
      },
      model: false,
      edits: [{ target: abstracts[0].id, action: 'replace', messages: [expect.anything()] }],
    },
  ])
  // The update replaced the first abstract's text where it stands: the tally keeps its order.
  const prompts = said(view.messages)
    .map(([, text]) => text)
    .slice(0, 2)
  expect(said(view.messages).map(([, text]) => text)).toEqual([
    ...prompts,
    `Abstract of #${first} Abstracts as of #${first}/${at}:\nAsk: one. State: done.`,
    `Abstract of #${other} Abstracts as of #${other}/${at}:\nAsk: two. State: started.`,
  ])
  expect(prompts.map((text) => text.split(' ')[0])).toEqual([`#${first}`, `#${other}`])
  expect((await server.harness.snapshot(Tally, server.root.id, context))!.abstracts).toEqual({
    [first]: { anchor: abstracts[0].id, text: 'Ask: one. State: done.', ...fields },
    [other]: { anchor: abstracts[1].id, text: 'Ask: two. State: started.', ...fields },
  })
  await until(
    async () =>
      (await server.harness.snapshot(Tally, server.root.id, context))?.tokens ===
      (await tallyTokens(server, server.root.id)),
  )

  // A landing freezes the open abstract into its note; a rerun of the same request writes nothing more.
  const host = { harness: () => server.harness }
  const landing = {
    from: first,
    source: 'lander' as const,
    requestId: 'lander-root:x',
    data: { sha: 'abc1234' },
  }
  for (let run = 0; run < 2; run++) await leaveNote(host, 'root', 'Landed abc1234', landing)
  const landed = await server.root.context(context)
  const notes = landed.entries.filter((entry) => entry.kind === 'lineage.note')
  expect(notes).toHaveLength(1)
  expect(notes[0].data).toEqual({
    sha: 'abc1234',
    text: 'Landed abc1234',
    from: first,
    source: 'lander',
    abstract: { text: 'Ask: one. State: done.', ...fields },
  })
  expect(notes[0].edits).toEqual([{ target: abstracts[0].id, action: 'omit' }])
  const frozen = `Note from the lander: Landed abc1234\n\nState at landing (abstract as of #${first}/${at}):\nAsk: one. State: done.`
  expect(said(landed.messages).map(([, text]) => text)).toEqual([
    ...prompts,
    `Abstract of #${other} Abstracts as of #${other}/${at}:\nAsk: two. State: started.`,
    frozen,
  ])
  expect(
    (await server.harness.snapshot(Tally, server.root.id, context))!.abstracts[first],
  ).toBeUndefined()

  // The next abstract starts a new anchor after the landing, which keeps its frozen state.
  await write(first, 'Ask: one more. State: started.')
  const after = await server.root.context(context)
  const reopened = after.entries.at(-1)!
  expect([reopened.kind, !!reopened.model, reopened.edits]).toEqual([
    'lineage.abstract',
    true,
    undefined,
  ])
  expect(
    said(after.messages)
      .map(([, text]) => text)
      .slice(-2),
  ).toEqual([
    frozen,
    `Abstract of #${first} Abstracts as of #${first}/${at}:\nAsk: one more. State: started.`,
  ])
  expect(
    (await server.harness.snapshot(Tally, server.root.id, context))!.abstracts[first].anchor,
  ).toBe(reopened.id)

  // Roots, subagents and conversations outside any tree write no abstract.
  const subagent = await server.harness.commit(async (tx) => {
    const owner = await tx.createTask(anchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: first,
      background: true,
    })
    return (await tx.createConversation({ ownership: { kind: 'task', taskId: owner } })).id
  }, context)
  const outside = (
    await server.harness.createConversation({ ownership: { kind: 'ownerless' } }, context)
  ).id
  for (const id of [ROOT_CONVERSATION_ID, subagent, outside]) {
    expect(await lineage.branchOf(id, context)).toBeUndefined()
    await write(id, 'Nothing')
  }
  expect(
    (await server.root.context(context)).entries.filter(
      (entry) => entry.kind === 'lineage.abstract',
    ),
  ).toHaveLength(4)
})

it('places a landing in a tally in one transaction, so an abstract never opens before it', async () => {
  const { server } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Land me' })
  await settled(server, first)
  // An abstract that arrives right after a landing checked for one, as if between a separate check and placement.
  let raced = false
  const race = async () => {
    if (raced) return
    raced = true
    await server.harness.commit(
      (tx) => abstract(tx, first, { text: 'State: raced.', at: 1 }),
      context,
    )
  }
  const harness = server.harness
  const host = {
    harness: () => ({
      commit: harness.commit.bind(harness),
      snapshot: harness.snapshot.bind(harness),
      conversation: async (id: ConversationId, ctx: typeof context) => {
        const conversation = (await harness.conversation(id, ctx))!
        return {
          submit: async (...args: Parameters<typeof conversation.submit>) => {
            await race()
            return conversation.submit(...args)
          },
        }
      },
    }),
  } as unknown as Parameters<typeof leaveNote>[0]
  const landing = {
    from: first,
    source: 'lander' as const,
    requestId: 'lander-root:race',
    data: { sha: 'def5678' },
  }
  for (let run = 0; run < 2; run++) await leaveNote(host, 'root', 'Landed def5678', landing)
  await race()
  const { entries } = await server.root.context(context)
  const notes = entries.filter((entry) => entry.kind === 'lineage.note')
  expect(notes).toHaveLength(1)
  expect((notes[0].data as { abstract?: unknown }).abstract).toBeUndefined()
  // The abstract is liquid after the landing, never left open above it.
  const open = (await server.harness.snapshot(Tally, server.root.id, context))!.abstracts[first]
  expect(open.anchor).toBeGreaterThan(notes[0].id)
})

it('summarizes a branch into its title and its abstract in the tree root', async () => {
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
          activity: 'Finished the new work.',
          title: 'Summarized branch',
          summary: 'Finished the new work.',
          abstract: 'Ask: new intent\nDiverged: none\nState: done',
        }),
      ),
    }),
  )
  const id = await branchFrom(server, { from: 1, prompt: 'New intent' })
  expect(server.api.conversations().find((item) => item.id === id)?.title).toBe('New intent')
  await until(
    async () =>
      (await server.harness.snapshot(Metadata, id, context))?.title === 'Summarized branch',
  )
  expect((await server.harness.snapshot(Summaries, id, context))?.generatedTitle).toBe(
    'Summarized branch',
  )
  await until(
    async () =>
      (await server.harness.snapshot(Tally, ROOT_CONVERSATION_ID, context))?.abstracts[id] !==
      undefined,
  )
  const { messages } = await server.root.context(context)
  expect(textOf(messages.at(-1)!.content)).toMatch(
    new RegExp(`^Abstract of #${id} Summarized branch as of #${id}/\\d+:\nAsk: new intent`),
  )
})

it('sorts a new branch from the moment it was asked for, not by the history it inherited', async () => {
  const { server } = await fixture()
  await (
    await server.root.submit({ type: 'input', content: 'An old idea.' }, context)
  ).wait(context)
  await until(
    async () =>
      (await server.harness.snapshot(Metadata, server.root.id, context))?.inputAt !== undefined,
  )
  const inherited = (await server.harness.snapshot(Metadata, server.root.id, context))!.inputAt!
  const asked = Date.now()
  const id = await branchFrom(server, { from: server.root.id, prompt: 'New intent' })
  await settled(server, id)
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

it('notifies with the branch’s own answer, never one it inherited', async () => {
  const { server } = await fixture()
  await (await server.root.submit({ type: 'input', content: 'An idea.' }, context)).wait(context)
  const id = await branchFrom(server, { from: 1, prompt: 'Fix the lost answers' })
  expect((await server.harness.snapshot(Metadata, id, context))?.title).toBe('Fix the lost answers')
  await server.root.submit({ type: 'input', content: `NOTIFY ${JSON.stringify({ id })}` }, context)
  await settled(server, id)
  await until(async () =>
    (await server.root.context(context)).entries.some((entry) => entry.kind === 'lineage.finished'),
  )
  const finished = (await server.root.context(context)).entries.find(
    (entry) => entry.kind === 'lineage.finished',
  )!
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
  expect(textOf(marker.model?.[0]?.content)).toContain('LINEAGE SUMMARY of This is the tally')
})

it('compacts a tally from its model view, then opens a new abstract after it', async () => {
  const { server, condensed } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Abstract me' })
  await settled(server, first)
  for (const text of ['State: started.', 'State: done.'])
    await server.harness.commit((tx) => abstract(tx, first, { text, at: 1 }), context)
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(server.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  await server.harness.waitForTask(await server.root.compact(undefined, context), context)
  expect((await server.root.context(context)).entries[0].kind).toBe('pi.compaction')
  const source = condensed.at(-1)!
  expect(source).toContain(`Abstract of #${first} as of #${first}/1:\nState: done.`)
  expect(source).not.toContain('State: started.')
  // The compaction replaced the anchor, so an edit of it would change nothing: the next abstract is a new anchor.
  await server.harness.commit(
    (tx) => abstract(tx, first, { text: 'State: after.', at: 1 }),
    context,
  )
  const { entries, messages } = await server.root.context(context)
  expect([entries.at(-1)!.kind, entries.at(-1)!.edits]).toEqual(['lineage.abstract', undefined])
  expect(textOf(messages.at(-1)!.content)).toBe(
    `Abstract of #${first} as of #${first}/1:\nState: after.`,
  )
})

it('keeps an abstract written while the tally compacts: it opens a new anchor', async () => {
  const { server, condensed, gate } = await fixture()
  const first = await branchFrom(server, { from: 1, prompt: 'Abstract me' })
  await settled(server, first)
  await server.harness.commit(
    (tx) => abstract(tx, first, { text: 'State: started.', at: 1 }),
    context,
  )
  await server.harness.commit(async (tx) => {
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(server.root.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  let release!: () => void
  gate.condense = new Promise((resolve) => (release = resolve))
  const task = await server.root.compact(undefined, context)
  // The compaction has chosen its range and waits for its summary when the update arrives.
  await until(async () => condensed.length > 0)
  await server.harness.commit(
    (tx) => abstract(tx, first, { text: 'State: during.', at: 2 }),
    context,
  )
  release()
  await server.harness.waitForTask(task, context)
  const { entries, messages } = await server.root.context(context)
  expect(entries[0].kind).toBe('pi.compaction')
  expect(
    said(messages)
      .map(([, text]) => text)
      .filter((text) => text.startsWith(`Abstract of #${first}`)),
  ).toEqual([`Abstract of #${first} as of #${first}/2:\nState: during.`])
  const open = (await server.harness.snapshot(Tally, server.root.id, context))!.abstracts[first]
  expect(entries.map((entry) => entry.id)).toContain(open.anchor)
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

it('notifies after the branch’s run without waiting for the branch’s own pending notify', async () => {
  const { server } = await fixture()
  const other = await second(server)
  const run = Promise.withResolvers<void>()
  const unrelated = Promise.withResolvers<void>()
  const runStarted = Promise.withResolvers<void>()
  const otherStarted = Promise.withResolvers<void>()
  const intent = `NOTIFY ${JSON.stringify({ id: other.id, wake: false })}`
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    // A system prompt that changed since the last run follows the history the branch inherited.
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
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
    await ask(server, server.root.id, 'An idea.')
    const target = await branchFrom(server, { from: 1, prompt: intent })
    await ask(server, server.root.id, `NOTIFY ${JSON.stringify({ id: target, wake: false })}`)
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
    run.resolve()
    unrelated.resolve()
  }
})

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
  const id = await branchFrom(server, { from: 1, prompt: 'Shared intent', isolated: false })
  const conversation = await settled(server, id)
  expect((await conversation.agent(context)).cwd).toBe(server.host.projectRoot)
})

it('delivers a branch’s prompt once when the process stops before it is submitted', async () => {
  const { server, home } = await fixture()
  // Without the prompt task's definition the task waits, as if the process went down right after creating the branch.
  const lineage = server.host.registry.snapshot().extension('lineage')!
  server.host.registry.install(
    defineExtension({
      ...lineage,
      tasks: lineage.tasks!.filter((task) => task.definition.name !== 'lineage.prompt'),
    }),
  )
  const id = await branchFrom(server, { from: 1, prompt: 'Survive a crash', isolated: false })
  const prompts = (target: Server) =>
    target.harness.commit(
      async (tx) => (await tx.scanTasks({ conversationId: id, kind: 'lineage.prompt' }, 10)).items,
      context,
    )
  expect((await prompts(server)).map((task) => [task.input, task.state.status])).toEqual([
    [{ id, prompt: 'Survive a crash' }, 'pending'],
  ])
  expect(
    (await (await server.harness.conversation(id, context))!.context(context)).entries.filter(
      (entry) => entry.conversationId === id,
    ),
  ).toEqual([])
  await server.close()
  servers.splice(servers.indexOf(server), 1)

  const { server: reopened } = await fixture(home)
  await until(async () => (await prompts(reopened))[0].state.status === 'terminal')
  const conversation = await settled(reopened, id)
  // A rerun of the delivery finds the submitted input by its request id.
  await conversation.submit(
    { type: 'input', content: 'Survive a crash', requestId: 'lineage:prompt' },
    context,
  )
  await conversation.waitForIdle(context)
  expect(said((await conversation.context(context)).messages)).toEqual([
    ['user', 'Survive a crash'],
    ['assistant', 'echo Survive a crash'],
  ])
})

it('defaults a branch to its source’s configuration', async () => {
  const { server } = await fixture()
  const model = { provider: 'faux', modelId: 'faux-b' }
  const other = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model, thinkingLevel: 'high' } },
    context,
  )
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
  }, context)
  await seedTally(server.harness, other.id)
  // Without a choice, the branch keeps its source's configuration.
  const agentOf = async (id: ConversationId) =>
    (await server.harness.conversation(id, context))!.agent(context)
  const followed = await branchFrom(server, { from: other.id, prompt: 'Follow B', isolated: false })
  expect(await agentOf(followed)).toMatchObject({ model, thinkingLevel: 'high' })
  await settled(server, followed)
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
  await server.harness.commit(async (tx) => {
    ;(await tx.doc(Roots, ROOT_CONVERSATION_ID)).roots.push(other.id)
  }, context)
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
  expect(await compacted(other.id)).toContain('LINEAGE SUMMARY of This is the tally')
  expect(await compacted(branch)).toContain('LINEAGE SUMMARY of This is a branch')
})
