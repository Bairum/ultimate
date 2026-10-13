import { resolve } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { Branch } from '../extensions/lineage/server.ts'
import { context } from '../server/harness.ts'
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
    const last = transcript.messages.findLast((message) => message.role === 'user')
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
