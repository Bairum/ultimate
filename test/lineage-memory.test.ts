import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  applyMemoryOps,
  Memory,
  MEMORY_LIMIT,
  parseMemoryOps,
} from '../extensions/lineage/memory.ts'
import { Seen } from '../extensions/lineage/catchup.ts'
import { abstract, Tally } from '../extensions/lineage/server.ts'
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate'
import { Standing } from '../extensions/subagents/api.ts'
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
async function fixture(settings?: object) {
  const home = await temp('ultimate-memory-')
  if (settings) {
    await mkdir(join(home, '.ultimate'), { recursive: true })
    await writeFile(join(home, '.ultimate/settings.json'), JSON.stringify(settings))
  }
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const state = { memorize: '{"ops":[]}', asked: [] as string[], condensed: [] as string[] }
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const [system, first] = transcript.messages
    if (system?.role === 'system' && textOf(system.content).startsWith('You keep a software')) {
      state.asked.push(textOf(first.content))
      return fauxAssistantMessage(state.memorize)
    }
    if (system?.role === 'system' && textOf(system.content).startsWith('You condense'))
      state.condensed.push(textOf(first.content))
    // Titles, reply summaries and compactions carry a system prompt of their own.
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
const branch = async (server: Server, prompt: string, from = 1, at?: number) => {
  const { status, data } = await post(server, '/api/extensions/lineage/actions/branch', {
    args: { from, prompt, ...(at === undefined ? {} : { at }) },
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
  expect(view.entries[0]).toMatchObject({ kind: 'pi.reset' })
  // Catch-up starts after the root's tip at the fork, not from the tally's start.
  const seen = await server.harness.snapshot(Seen, briefed.id, context)
  expect(seen?.tally).toBeGreaterThanOrEqual(tip)
  // The brief records the root tip it covers, for forks of this branch.
  expect(view.entries[0]).toMatchObject({ data: { lineage: { brief: { tally: tip } } } })
  // The root's footer counts the brief a branch receives, recounted when memory changes.
  const briefTokens = async () =>
    (await server.harness.snapshot(Tally, ROOT_CONVERSATION_ID, context))?.briefTokens
  await until(async () => (await briefTokens()) === estimateTextTokens(textOf(said[0].content)))
  await apply(server, [{ op: 'delete', slug: 'pnpm' }])
  await until(async () => (await briefTokens()) === undefined)
  const lineage = server.host.registry.snapshot().extension('lineage')!.sections![0]
  expect(
    await lineage.render(
      { conversationId: briefed.id } as Parameters<typeof lineage.render>[0],
      context,
    ),
  ).toContain("starts with your project's memory index")
})

it('accepts only one whole {ops} object as a memorize answer', () => {
  const ops = [{ op: 'delete', slug: 'pnpm' }]
  expect(parseMemoryOps(JSON.stringify({ ops }))).toEqual(ops)
  expect(parseMemoryOps(`\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\``)).toEqual(ops)
  for (const answer of [
    JSON.stringify([{ ops }]),
    JSON.stringify({ ops, note: 'extra' }),
    'null',
    `I would not answer ${JSON.stringify({ ops })} here: the landing changes nothing.`,
    `I can't help with that.\n${JSON.stringify({ ops })}`,
    `\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n\`\`\`json\n{"ops":[]}\n\`\`\``,
  ])
    expect(() => parseMemoryOps(answer)).toThrow('expected only {"ops": [...]}')
})

it.concurrent('forks of a briefed branch inherit the tally tip its brief covers', async () => {
  const { server } = await fixture()
  const older = (await server.harness.commit(
    async (tx) => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)).items[0].id,
    context,
  )) as number
  await branch(server, 'Moves the root on')
  await apply(server, [add('pnpm')])
  const b = await branch(server, 'Briefed from an older entry', 1, older)
  const [reset] = (await b.conversation.context(context)).entries
  const briefTip = (reset.data as { lineage: { brief: { tally: number } } }).lineage.brief.tally
  expect(briefTip).toBeGreaterThan(older)
  // C's tally position is B's brief tip, so its catch-up does not report the branch the brief already covered.
  const c = await branch(server, 'Fork of the briefed branch', b.id)
  const notes = (
    await server.harness.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId: c.id, minEntryId: reset.id }, 50)).items,
      context,
    )
  ).filter((entry) => entry.kind === 'lineage.note')
  expect(JSON.stringify(notes)).not.toContain('Moves the root on')
  expect((await server.harness.snapshot(Seen, c.id, context))?.tally).toBeGreaterThan(briefTip)
})

it.concurrent('reads memories with memory; only @ultimate writes them with remember', async () => {
  const { server } = await fixture()
  const { id } = await branch(server, 'Reader')
  expect(await run(server, 'memory', {}, id)).toBe('#1 has no memories yet.')
  // A branch finds the deferred tool with tool_search, so the call itself is refused.
  await expect(run(server, 'remember', { ops: [add('pnpm')] }, id)).rejects.toThrow(
    'Only @ultimate writes project memory',
  )
  expect(await memories(server)).toEqual({})
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  const ultimate = standing.data.result as number
  expect(
    await run(
      server,
      'remember',
      { root: 1, ops: [add('pnpm'), { ...add('lint'), source: '#2/3' }] },
      ultimate,
    ),
  ).toBe("Added pnpm, lint in #1's memory.")
  await expect(
    run(
      server,
      'remember',
      { root: 1, ops: [add('new'), { op: 'delete', slug: 'gone' }] },
      ultimate,
    ),
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
      (await tx.scanTasks({ conversationId: ROOT_CONVERSATION_ID, kind: 'lineage.memorize' }, 500))
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

  // Receipts are never evicted: after more than 100 further landings, the first again starts no task.
  state.memorize = '{"ops":[]}'
  await server.harness.commit(async (tx) => {
    for (let index = 0; index < 101; index++)
      await emit(tx, SubmissionLanded, landing(`bulk-${index}`, id))
  }, context)
  await settledTasks(server, 104)
  const repeat = (await land(landing('s1', id))).id
  await until(
    async () =>
      ((await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
        'lineage/memorize'
      ] ?? 0) >= repeat,
  )
  expect(await memorizeTasks(server)).toHaveLength(104)
})

it.concurrent('a fresh memorize reactor skips landings from before it and distils new ones', async () => {
  const { server, state } = await fixture()
  const { id } = await branch(server, 'Land me')
  state.memorize = JSON.stringify({ ops: [add('fresh')] })
  // Past landings with no memorize cursor, as on a fresh install: the reactor starts after them.
  await server.harness.commit(async (tx) => {
    for (let index = 0; index < 3; index++)
      await emit(tx, SubmissionLanded, landing(`past-${index}`, id))
    delete (await tx.doc(EventLog, ROOT_CONVERSATION_ID)).cursors['lineage/memorize']
  }, context)
  const cursor = async () =>
    (await server.harness.snapshot(EventLog, ROOT_CONVERSATION_ID, context))?.cursors[
      'lineage/memorize'
    ]
  await until(async () => (await cursor()) !== undefined)
  expect(await memorizeTasks(server)).toEqual([])
  await server.harness.commit((tx) => emit(tx, SubmissionLanded, landing('new', id)), context)
  await settledTasks(server, 1)
  expect(state.asked).toHaveLength(1)
  expect(state.asked[0]).toContain('Landed newabcd on main')
  expect(Object.keys(await memories(server))).toEqual(['fresh'])
})

it.concurrent('ends a compaction of @ultimate with its project memory', async () => {
  const { server, state } = await fixture()
  await apply(server, [add('kept-fact', 'The project keeps this fact')])
  const ultimate = await server.harness.createConversation(
    { ownership: { kind: 'ownerless' } },
    context,
  )
  const { model } = await server.root.agent(context)
  await server.harness.commit(async (tx) => {
    await configure(tx, ultimate.id, { model })
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = ultimate.id
    for (let n = 0; n < 8; n++)
      await tx.appendEntry(ultimate.id, {
        kind: 'pi.user',
        model: [{ role: 'user', content: `Part ${n} ${'word '.repeat(4000)}`, timestamp: n }],
      })
  }, context)
  await server.harness.waitForTask(await ultimate.compact(undefined, context), context)
  // The summary prompt carries the memory and says to leave out what it states.
  expect(state.condensed).toHaveLength(1)
  expect(state.condensed[0]).toContain('leave out what it already states')
  expect(state.condensed[0]).toContain('kept-fact [fact]')
  const marker = (await ultimate.context(context)).entries[0]
  expect(marker.kind).toBe('pi.compaction')
  const summary = textOf(marker.model?.[0]?.content)
  // The summary model's answer (faux answers `{}`), then the memory block.
  expect(summary).toMatch(
    /<summary>\n\{\}\n\n<project_memory root="#1">\nkept-fact \[fact\] — The project keeps this fact \(updated [\d-]+\)\n<\/project_memory>\nThe full project context[^\n]*`ultimate.entries\(1\)`[^\n]*\n<\/summary>$/,
  )
})

it.concurrent('completes a landing task without asking when no summary model runs', async () => {
  const { server, state } = await fixture({ summaryModel: 'not a model' })
  const { id } = await branch(server, 'Land me')
  state.memorize = JSON.stringify({ ops: [add('never')] })
  await server.harness.commit((tx) => emit(tx, SubmissionLanded, landing('s1', id)), context)
  await settledTasks(server, 1)
  expect(state.asked).toEqual([])
  expect(await memories(server)).toEqual({})
})
