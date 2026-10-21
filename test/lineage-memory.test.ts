import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { applyMemoryOps, Memory, MEMORY_LIMIT } from '../extensions/lineage/memory.ts'
import { Seen } from '../extensions/lineage/catchup.ts'
import { abstract } from '../extensions/lineage/server.ts'
import { SubmissionLanded } from '../extensions/workspaces/api.ts'
import type { LandedData } from '../extensions/workspaces/api.ts'
import { emit, EventLog } from '../server/events.ts'
import { context } from '../server/harness.ts'
import { fauxServer, post, seedTally, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  // The default summary model is faux's own on a faux server.
  await writeFile(join(ultimateRoot, '.ultimate/settings.json'), JSON.stringify({}))
})
type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : ((content ?? []) as { type: string; text?: string }[])
        .flatMap((part) => (part.type === 'text' ? [part.text!] : []))
        .join('')

/** A faux server that echoes; memorize requests answer `state.memorize` and are counted. */
async function fixture() {
  const home = await temp('ultimate-memory-')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const state = { memorize: '{"ops":[]}', asked: [] as string[] }
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const [system, first] = transcript.messages
    if (system?.role === 'system' && textOf(system.content).startsWith('You keep a software')) {
      state.asked.push(textOf(first.content))
      return fauxAssistantMessage(state.memorize)
    }
    // Titles and reply summaries carry a system prompt of their own.
    if (system?.role === 'system' && textOf(system.content)) return fauxAssistantMessage('{}')
    const last = transcript.messages.findLast((message) => message.role === 'user')
    return fauxAssistantMessage(`echo ${textOf(last?.content)}`)
  }
  server.host.faux!.setResponses([route])
  await seedTally(server.harness)
  return { server, state }
}

const memories = async (server: Server, root = ROOT_CONVERSATION_ID) =>
  (await server.harness.snapshot(Memory, root, context))?.memories ?? {}
const apply = (server: Server, ops: unknown[], root = 1) =>
  server.harness.commit((tx) => applyMemoryOps(tx, root, ops, Date.UTC(2026, 9, 21)), context)
const add = (slug: string, line = `About ${slug}`) => ({
  op: 'add',
  slug,
  kind: 'fact',
  line,
  body: `${line}, in full.`,
})
const branch = async (server: Server, prompt: string) => {
  const { status, data } = await post(server, '/api/extensions/lineage/actions/branch', {
    args: { from: 1, prompt },
  })
  expect([status, data.error]).toEqual([200, undefined])
  const id = data.result.id as ConversationId
  const conversation = (await server.harness.conversation(id, context))!
  await conversation.waitForIdle(context)
  return { id, conversation }
}
const tool = (server: Server, name: string) =>
  server.host.registry
    .snapshot()
    .extension('lineage')!
    .tools!.find((candidate) => candidate.name === name)!
const run = async (server: Server, name: string, args: object, caller: number) => {
  const found = tool(server, name)
  const api = {
    conversationId: caller,
    commit: (change: Parameters<typeof server.harness.commit>[0]) =>
      server.harness.commit(change, context),
  } as unknown as Parameters<typeof found.execute>[1]
  const result = await found.execute(args, api, context)
  return textOf(result.output)
}

it.concurrent('applies memory ops atomically and holds the cap', async () => {
  const { server } = await fixture()
  expect(await apply(server, [add('pnpm'), add('node')])).toBe("Added pnpm, node in #1's memory.")
  expect(
    await apply(server, [
      { op: 'update', slug: 'pnpm', line: 'Use pnpm 11' },
      { op: 'delete', slug: 'node' },
    ]),
  ).toBe("updated pnpm; deleted node in #1's memory.")
  expect(await memories(server)).toEqual({
    pnpm: {
      kind: 'fact',
      line: 'Use pnpm 11',
      body: 'About pnpm, in full.',
      updated: Date.UTC(2026, 9, 21),
    },
  })

  // Any invalid op refuses the whole batch: the valid add before it is not written either.
  for (const [ops, error] of [
    [[add('fine'), add('pnpm')], 'pnpm exists'],
    [[add('fine'), { op: 'update', slug: 'missing', line: 'x' }], 'no memory missing'],
    [[add('fine'), { op: 'delete', slug: 'missing' }], 'no memory missing'],
    [[add('fine'), add('Bad_Slug')], 'slug must match'],
    [[add('fine'), add('long', 'x'.repeat(121))], 'at most 120'],
    [[add('fine'), { ...add('multi'), line: 'one\ntwo' }], 'one non-empty line'],
    [[add('fine'), { ...add('big'), body: 'x'.repeat(2001) }], 'at most 2000'],
    [[add('fine'), { ...add('odd'), kind: 'opinion' }], 'kind must be'],
  ] as const)
    await expect(apply(server, [...ops])).rejects.toThrow(error)
  expect(Object.keys(await memories(server))).toEqual(['pnpm'])
  await expect(apply(server, [add('x')], 99)).rejects.toThrow('not a listed root')

  // At the cap a further add refuses; a delete and an add in one batch pass.
  await apply(
    server,
    Array.from({ length: MEMORY_LIMIT - 1 }, (_, index) => add(`m-${index}`)),
  )
  expect(Object.keys(await memories(server))).toHaveLength(MEMORY_LIMIT)
  await expect(apply(server, [add('one-more')])).rejects.toThrow('exceed the limit of 150')
  await apply(server, [{ op: 'delete', slug: 'm-0' }, add('one-more')])
  const after = await memories(server)
  expect(Object.keys(after)).toHaveLength(MEMORY_LIMIT)
  expect(after['one-more']).toBeDefined()
  expect(after['m-0']).toBeUndefined()
})

it.concurrent('starts a branch from the memory brief, and without memories from the tally', async () => {
  const { server } = await fixture()
  // Without memories a branch inherits the tally, as before.
  const plain = await branch(server, 'Plain branch')
  const marker = 'TALLY ABSTRACT TEXT'
  await server.harness.commit(
    (tx) => abstract(tx, plain.id, { text: marker, at: 3, title: 'Plain' }),
    context,
  )
  const inherited = await branch(server, 'Inherits the tally')
  expect(JSON.stringify((await inherited.conversation.context(context)).messages)).toContain(marker)

  await apply(server, [add('pnpm', 'Use pnpm for everything')])
  const tip = (await server.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)).items[0].id,
    context,
  )) as number
  const briefed = await branch(server, 'Briefed branch')
  const view = await briefed.conversation.context(context)
  const said = view.messages.filter((message) => message.role !== 'system')
  // The model context begins at the brief, then the prompt: none of the tally.
  expect(textOf(said[0].content)).toMatch(
    /^<project_memory root="#1">\npnpm \[fact\] — Use pnpm for everything \(updated 2026-10-21\)\n<\/project_memory>\n/,
  )
  expect(textOf(said[0].content)).toContain('ultimate.entries(1)')
  expect(textOf(said[1].content)).toBe('Briefed branch')
  expect(JSON.stringify(view.messages)).not.toContain(marker)
  expect(view.entries[0]).toMatchObject({ kind: 'pi.reset', data: { lineage: { brief: true } } })
  // Catch-up starts after the root's tip at the fork, not from the tally's start.
  const seen = await server.harness.snapshot(Seen, briefed.id, context)
  expect(seen?.tally).toBeGreaterThanOrEqual(tip)
  const lineage = server.host.registry.snapshot().extension('lineage')!.sections![0]
  expect(
    await lineage.render(
      { conversationId: briefed.id } as Parameters<typeof lineage.render>[0],
      context,
    ),
  ).toContain("starts with your project's memory index")
})

it.concurrent('reads memories with memory and writes them with remember', async () => {
  const { server } = await fixture()
  const { id } = await branch(server, 'Reader')
  expect(await run(server, 'memory', {}, id)).toBe('#1 has no memories yet.')
  expect(
    await run(server, 'remember', { ops: [add('pnpm'), { ...add('lint'), source: '#2/3' }] }, id),
  ).toBe("Added pnpm, lint in #1's memory.")
  await expect(
    run(server, 'remember', { ops: [add('new'), { op: 'delete', slug: 'gone' }] }, id),
  ).rejects.toThrow('no memory gone')
  expect(Object.keys(await memories(server)).toSorted()).toEqual(['lint', 'pnpm'])
  expect(await run(server, 'memory', {}, id)).toMatch(
    /^#1's memory \(2\):\nlint \[fact\] — About lint \(updated \d{4}-\d\d-\d\d\)\npnpm \[fact\]/,
  )
  expect(await run(server, 'memory', { read: 'lint' }, id)).toMatch(
    /^lint \[fact\] — About lint \(updated [\d-]+\)\nSource: #2\/3\n\nAbout lint, in full\.$/,
  )
  await expect(run(server, 'memory', { read: 'nope' }, id)).rejects.toThrow('no memory nope')
  // The user's forget goes through the same write path.
  const forgot = await post(server, '/api/extensions/lineage/actions/forget', {
    args: { root: 1, slug: 'lint' },
  })
  expect(forgot.data.result).toEqual({ summary: "deleted lint in #1's memory." })
  expect(Object.keys(await memories(server))).toEqual(['pnpm'])
})

const landing = (submission: string, conversationId: number): LandedData => ({
  submission,
  conversationId,
  at: 3,
  sha: `${submission}abcdef0`,
  base: '0000000',
  target: 'main',
  lander: 2,
  divergence: 'None',
  title: 'Land me',
  feature: 'Landing',
  commits: [{ sha: 'abc1234', subject: `feat: ${submission}` }],
  commitCount: 1,
  paths: ['landed.txt'],
})
const memorizeTasks = (server: Server) =>
  server.harness.commit(
    async (tx) =>
      (await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: 'lineage.memorize' }, 50))
        .items,
    context,
  )
const settledTasks = async (server: Server, count: number) => {
  await until(async () => {
    const tasks = await memorizeTasks(server)
    return tasks.length === count && tasks.every((task) => task.state.status === 'terminal')
  })
  for (const task of await memorizeTasks(server))
    expect(task.state).toMatchObject({ outcome: { status: 'completed' } })
}

it.concurrent('distils each landing into memory once and writes nothing from a refused answer', async () => {
  const { server, state } = await fixture()
  const { id } = await branch(server, 'Land me')
  await server.harness.commit((tx) => abstract(tx, id, { text: 'State: done.', at: 3 }), context)
  await apply(server, [add('old-tool', 'Uses old-tool')])
  state.memorize = `\`\`\`json\n${JSON.stringify({
    ops: [
      { op: 'delete', slug: 'old-tool' },
      {
        op: 'add',
        slug: 'new-tool',
        kind: 'decision',
        line: 'Use new-tool',
        body: 'old-tool was replaced by new-tool.',
      },
    ],
  })}\n\`\`\``
  const land = (data: LandedData) =>
    server.harness.commit((tx) => emit(tx, SubmissionLanded, data), context)
  await land(landing('s1', id))
  await settledTasks(server, 1)
  expect(await memories(server)).toEqual({
    'new-tool': {
      kind: 'decision',
      line: 'Use new-tool',
      body: 'old-tool was replaced by new-tool.',
      source: `#${id}/3`,
      updated: expect.any(Number),
    },
  })
  // The model read the landing, the submitter's abstract frozen into it, and the memory with bodies.
  expect(state.asked).toHaveLength(1)
  expect(state.asked[0]).toContain('Landed s1abcde on main')
  expect(state.asked[0]).toContain('State: done.')
  expect(state.asked[0]).toContain('old-tool [fact] — Uses old-tool')

  // The same landing again starts no second task, so its ops apply once.
  const again = (await land(landing('s1', id))).id
  await until(
    async () =>
      ((await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
        'lineage/memorize'
      ] ?? 0) >= again,
  )
  expect(await memorizeTasks(server)).toHaveLength(1)

  // A malformed answer, and a batch applyMemoryOps refuses, write nothing.
  const before = await memories(server)
  state.memorize = 'Sure! Here are the ops: none'
  await land(landing('s2', id))
  await settledTasks(server, 2)
  state.memorize = JSON.stringify({
    ops: [
      { op: 'add', slug: 'fine', kind: 'fact', line: 'Fine', body: 'Fine.' },
      { op: 'update', slug: 'missing', line: 'x' },
    ],
  })
  await land(landing('s3', id))
  await settledTasks(server, 3)
  expect(state.asked).toHaveLength(3)
  expect(await memories(server)).toEqual(before)
})
