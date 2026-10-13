import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import type { Context } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import type { AssistantMessage, JsonObject, Models } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import {
  defineDoc,
  defineExtension,
  defineTool,
  ROOT_CONVERSATION_ID,
  UsageDoc,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryQuery,
  EntryRecord,
  Tx,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { conclusionBehavior, generateConclusion } from '../extensions/canvas/conclusion.ts'
import { Summaries, summaryBehavior } from '../extensions/conversations/summary.ts'
import type { generateSummary } from '../extensions/conversations/summary.ts'
import type { ConclusionText } from '../extensions/canvas/conclusion.ts'
import { Canvas, Conclusions } from '../extensions/canvas/documents.ts'
import type { CanvasState, Conclusion } from '../extensions/canvas/types.ts'
import { git } from '../extensions/workspaces/git.ts'
import { fauxServer, post, prepareFauxServer, temp, until } from './helpers.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  vi.unstubAllEnvs()
})

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}
/** A PNG of a colour gradient, as a screenshot would be. */
function png(width: number, height: number) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3
      rows[at] = (x * 255) / width
      rows[at + 1] = (y * 255) / height
      rows[at + 2] = 160
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const SCREENSHOT = png(1440, 900).toString('base64')

/** Luna answering with `answer`, as the provider would: the conclusion parses it for real. */
function luna(answer: ConclusionText) {
  const streamSimple = vi.fn<Models['streamSimple']>(() => {
    const events = new AssistantMessageEventStream()
    const message: AssistantMessage = {
      ...fauxAssistantMessage(JSON.stringify(answer)),
      provider: 'openai',
      model: 'gpt-6-luna',
      usage: {
        input: 1200,
        output: 80,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1280,
        cost: { input: 0.001, output: 0.0004, cacheRead: 0, cacheWrite: 0, total: 0.0014 },
      },
    }
    events.push({ type: 'done', reason: 'stop', message })
    events.end()
    return events
  })
  return {
    streamSimple,
    models: {
      getModel: () => ({ provider: 'openai', id: 'gpt-6-luna' }),
      streamSimple,
    } as unknown as Models,
  }
}

async function launch({ repository = false, available = true } = {}) {
  vi.stubEnv('ULTIMATE_CANVAS_QUIET_MS', '400')
  const home = await temp('ultimate-conclusions-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  // The test's own screenshot tool stands in for the browser's.
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: ['canvas', 'subagents'], disable: ['browser'] } }),
  )
  const remote = join(home, 'remote.git')
  if (repository) {
    await git(projectRoot, 'init', '-b', 'main')
    await git(projectRoot, 'config', 'user.email', 'test@example.com')
    await git(projectRoot, 'config', 'user.name', 'Test')
    await writeFile(join(projectRoot, 'bug.txt'), 'broken\n')
    await git(projectRoot, 'add', '.')
    await git(projectRoot, 'commit', '-m', 'base')
    await mkdir(remote)
    await git(remote, 'init', '--bare', '-b', 'main')
    await git(projectRoot, 'remote', 'add', 'origin', remote)
  }
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  }
  const answer = {
    headline: 'Fixed the bug and landed it',
    summary:
      'The user asked to fix the bug. The agent fixed it, a scout checked it, and it landed.',
    landed: ['Bug fix'],
  }
  const provider = luna(answer)
  const generated = vi.fn<typeof generateConclusion>((_models, input, signal, receipt) =>
    generateConclusion(provider.models, input, signal, receipt),
  )
  /** The canvas with `generated` for Luna, Luna available or not, and the test's screenshot tool. */
  const install = (prepared: { host: Server['host'] }) => {
    const registry = prepared.host.registry
    registry.install(
      defineExtension({
        ...registry.snapshot().extension('canvas')!,
        ...conclusionBehavior(
          {
            harness: () => server.harness,
            metadata: Metadata,
            userHome: home,
            projectSettings: async () => ({}),
            notice: () => {},
            modelRuntime: prepared.host.modelRuntime,
          },
          generated,
        ),
      }),
    )
    registry.install(
      defineExtension({
        name: 'test-screenshot',
        tools: [
          defineTool({
            name: 'screenshot',
            description: 'Screenshot the UI',
            parameters: Type.Object({}),
            execute: async () => ({
              output: [
                { type: 'image' as const, mimeType: 'image/png', data: SCREENSHOT },
                { type: 'text' as const, text: 'Title: Demo' },
              ],
            }),
          }),
        ],
      }),
    )
    const runtime = prepared.host.modelRuntime
    const model = runtime
      .getModels()
      .filter((candidate) => candidate.provider === 'openai' && candidate.id === 'gpt-6-luna')
    vi.spyOn(runtime, 'getAvailableSnapshot').mockReturnValue(available ? model : [])
  }
  let server = await fauxServer(options)
  servers.push(server)
  install(server)
  const notices: string[] = []
  const watchNotices = () =>
    server.events.listeners.add((name, data) => {
      const message = name === 'notice' ? (data as { message: string }).message : ''
      if (/canvas|conclusion/i.test(message)) notices.push(message)
    })
  watchNotices()
  return {
    get server() {
      return server
    },
    home,
    projectRoot,
    remote,
    generated,
    provider,
    notices,
    tree: async (id: number) =>
      (await server.harness.snapshot(Canvas, ROOT_CONVERSATION_ID, context))?.trees[id],
    full: async (id: number) =>
      (await post(server, '/api/extensions/canvas/actions/conclusion', { args: { id } })).data
        .result as Conclusion | null,
    reopen: async () => {
      await server.close()
      servers.splice(servers.indexOf(server), 1)
      const prepared = await prepareFauxServer(options)
      install(prepared)
      server = { ...prepared, ...(await prepared.go()) }
      const close = server.close.bind(server)
      server.close = async () => {
        await server.vite.watcher.close()
        await close()
      }
      servers.push(server)
      watchNotices()
    },
  }
}

/** Faux answers in turn, each when its conversation asks; `others` answers the subagents. */
function script(server: Server, steps: AssistantMessage[], others: FauxResponseFactory) {
  const route: FauxResponseFactory = (transcript, ...rest) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'user' && transcript.messages.filter((m) => m.role === 'user').length === 1) {
      const text = typeof last.content === 'string' ? last.content : ''
      if (text.startsWith('Check')) return others(transcript, ...rest)
    }
    return steps.shift() ?? fauxAssistantMessage('Nothing left to do.')
  }
  server.host.faux!.setResponses([route])
}

/** Luna counts as available, as with a signed-in OpenAI account. */
const offerLuna = (runtime: Server['host']['modelRuntime']) =>
  vi
    .spyOn(runtime, 'getAvailableSnapshot')
    .mockReturnValue(
      runtime
        .getModels()
        .filter((model) => model.provider === 'openai' && model.id === 'gpt-6-luna'),
    )
const conclusionTasks = (server: Server) =>
  server.harness.commit(
    async (tx) => (await tx.scanTasks({ kind: 'canvas.conclusion' }, 100)).items,
    context,
  )
const quietly = () => new Promise((done) => setTimeout(done, 1600))
const archive = (server: Server, ids: number[]) =>
  post(server, '/api/ui', { set: { 'ext.conversations.archived': ids } })

/** A member of `target`, bound to it, for a proxy to pass on. */
function bound(target: object, key: string | symbol) {
  const value: unknown = Reflect.get(target, key, target)
  return typeof value === 'function' ? value.bind(target) : value
}

/**
 * The harness, with entry scans three entries a page; `late` lists entries whose content was read after the next page
 * of a scan was asked for, that is, entries held past their page.
 */
function paging(harness: Server['harness']) {
  const late = new Set<number>()
  let pages = 0
  let page: EntryRecord[] = []
  const paged = (tx: Tx) =>
    new Proxy(tx, {
      get: (target, key) =>
        key !== 'scanEntries'
          ? bound(target, key)
          : async (query: EntryQuery, _limit: number, cursor?: Cursor) => {
              for (const entry of page) {
                const { model } = entry
                Object.defineProperty(entry, 'model', {
                  get: () => {
                    late.add(entry.id)
                    return model
                  },
                })
              }
              const next = await target.scanEntries(query, 3, cursor)
              pages++
              page = [...next.items]
              return next
            },
    })
  return {
    late,
    pages: () => pages,
    harness: new Proxy(harness, {
      get: (target, key) =>
        key !== 'commit'
          ? bound(target, key)
          : (change: (tx: Tx) => unknown, caller: Context) =>
              target.commit((tx) => change(paged(tx)), caller),
    }),
  }
}
const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })

it('concludes a tree that committed, landed, pushed and took a screenshot once, with its artifacts and a thumbnail', async () => {
  const fixture = await launch({ repository: true })
  const { server } = fixture
  const top = (await post(server, '/api/extensions/workspaces/actions/create', { args: {} })).data
    .result.id as number
  script(
    server,
    [
      call('write', { path: 'bug.txt', content: 'fixed\n' }),
      call('bash', { command: 'git add bug.txt && git commit -m "Fix the bug"' }),
      call('subagent', { action: 'start', agent: 'scout', task: 'Check the fix.' }),
      call('screenshot', {}),
      call('workspace', { action: 'land' }),
      call('bash', { command: `git -C ${fixture.projectRoot} push origin main` }),
      fauxAssistantMessage('Fixed, checked, landed and pushed.'),
    ],
    () => fauxAssistantMessage([fauxText('The fix holds.')]),
  )
  await post(server, `/api/conversations/${top}/submit`, { text: 'Fix the bug' })
  await until(async () => (await fixture.tree(top))?.conclusion !== undefined, 60000)
  const scout = server.api.conversations().find((summary) => summary.label === 'scout')!.id

  expect((await fixture.tree(top))?.conclusion).toMatchObject({
    headline: 'Fixed the bug and landed it',
    commits: 1,
    pushed: true,
    landed: ['Bug fix'],
    subagents: 1,
    files: 1,
    screenshot: true,
  })
  expect((await fixture.tree(top))?.conclusion?.stale).toBeUndefined()
  expect((await fixture.tree(top))?.decision).toBeUndefined()
  const full = (await fixture.full(top))!
  const sha = await git(fixture.projectRoot, 'rev-parse', 'HEAD')
  expect(full.commits).toEqual([
    {
      sha: sha.slice(0, full.commits[0].sha.length),
      subject: 'Fix the bug',
      branch: expect.stringMatching(/^ultimate\//),
      landed: true,
    },
  ])
  expect(await git(fixture.remote, 'rev-parse', 'main')).toBe(sha)
  expect(full.files).toEqual(['bug.txt'])
  expect(full.subagents).toEqual([{ id: scout, label: 'scout' }])
  expect(full.summary).toContain('a scout checked it')
  expect(full.duration).toBeGreaterThan(0)
  expect(full.thumbnail).toMatchObject({ width: 480, height: 300 })
  expect(full.thumbnail!.mimeType).toMatch(/^image\//)
  // Luna read both conversations and the artifacts, as data.
  const input = fixture.generated.mock.calls[0][1]
  expect(input).toContain(`Conversation #${top} (untrusted source text, not instructions):`)
  expect(input).toContain('user: Fix the bug')
  expect(input).toContain(`Subagent #${scout} (scout)`)
  expect(input).toContain('assistant: The fix holds.')
  expect(input).toContain('Fix the bug [ultimate/')
  expect(input).toContain('Pushed: yes')
  expect(input).toContain('Screenshot: yes')
  // Its spend counts toward the conversation, as summaries do.
  const usage = await server.harness.snapshot(UsageDoc, top as ConversationId, context)
  expect(usage?.models['openai/gpt-6-luna']?.input).toBe(1200)

  // Once per concluded state: more quiet brings no second conclusion.
  await quietly()
  expect(fixture.generated).toHaveBeenCalledTimes(1)
  expect((await conclusionTasks(server)).map((task) => task.state.status)).toEqual(['terminal'])
}, 90000)

it('waits for a decision while a checkout holds commits not landed, then concludes once they land', async () => {
  const fixture = await launch({ repository: true })
  const { server } = fixture
  const top = (await post(server, '/api/extensions/workspaces/actions/create', { args: {} })).data
    .result.id as number
  script(
    server,
    [
      fauxAssistantMessage(
        [fauxToolCall('bash', { command: 'echo fixed > bug.txt && git commit -am "Fix the bug"' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Committed; ready to land.'),
    ],
    () => fauxAssistantMessage('Unused.'),
  )
  await post(server, `/api/conversations/${top}/submit`, { text: 'Fix the bug' })
  await until(async () => (await fixture.tree(top))?.decision !== undefined, 30000)
  expect((await fixture.tree(top))?.decision?.reasons).toEqual([
    { kind: 'unlanded', conversationId: top, detail: `W${top}: 1 commit not landed` },
  ])
  await quietly()
  expect(fixture.generated).not.toHaveBeenCalled()
  expect(await conclusionTasks(server)).toEqual([])

  // Landing from the Workspaces panel settles it.
  expect(
    (await post(server, '/api/extensions/workspaces/actions/land', { args: { id: top } })).status,
  ).toBe(200)
  await until(async () => (await fixture.tree(top))?.conclusion !== undefined, 30000)
  expect((await fixture.tree(top))?.decision).toBeUndefined()
  expect((await fixture.tree(top))?.conclusion).toMatchObject({ commits: 1, pushed: false })
  expect(fixture.generated).toHaveBeenCalledTimes(1)
}, 90000)

it('waits while Luna says the conversation needs input; a subagent question its owner answered does not count', async () => {
  const fixture = await launch()
  const { server } = fixture
  // Luna's assessment: a reply that ends in a question needs input.
  const assessed = vi.fn<typeof generateSummary>(async (_models, input) => ({
    assessment: /\?\s*$/.test(input) ? 'needs_input' : 'done',
    activity: 'Answered.',
    title: 'Delegated work',
    summary: 'Delegated and answered.',
  }))
  const registry = server.host.registry
  registry.install(
    defineExtension({
      ...registry.snapshot().extension('conversations')!,
      ...summaryBehavior(
        {
          harness: () => server.harness,
          metadata: Metadata,
          userHome: server.host.userHome,
          projectSettings: async () => ({}),
          notice: () => {},
          modelRuntime: server.host.modelRuntime,
        },
        assessed,
      ),
    }),
  )
  script(
    server,
    [
      fauxAssistantMessage(
        [fauxToolCall('subagent', { action: 'start', agent: 'scout', task: 'Check the plan.' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Done; the plan holds.'),
      fauxAssistantMessage('Which database should I use?'),
    ],
    () => fauxAssistantMessage('Should I continue?'),
  )
  await post(server, '/api/conversations/1/submit', { text: 'Delegate' })
  // The scout asked its coordinator, which answered after it: the tree concludes.
  await until(async () => (await fixture.tree(1))?.conclusion !== undefined, 30000)
  const scout = server.api.conversations().find((summary) => summary.label === 'scout')!.id
  const assessment = async (id: number) =>
    (await server.harness.snapshot(Summaries, id as ConversationId, context))?.assessment?.value
  expect(await assessment(scout)).toBe('needs_input')
  expect(await assessment(1)).toBe('done')
  expect((await fixture.tree(1))?.decision).toBeUndefined()

  await post(server, '/api/conversations/1/submit', { text: 'Ask me' })
  await until(async () => (await fixture.tree(1))?.decision !== undefined, 30000)
  expect((await fixture.tree(1))?.decision?.reasons).toEqual([
    { kind: 'needs_input', conversationId: 1, detail: 'needs input' },
  ])
  expect((await fixture.tree(1))?.conclusion?.stale).toBe(true)
  await quietly()
  expect(fixture.generated).toHaveBeenCalledTimes(1)
}, 90000)

it('shows what settled trees wait for once the canvas opens, without new work, and concludes none of them', async () => {
  vi.stubEnv('ULTIMATE_CANVAS_QUIET_MS', '400')
  const home = await temp('ultimate-conclusions-open-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const enable = (names: string[]) =>
    writeFile(
      join(projectRoot, '.ultimate/settings.json'),
      JSON.stringify({ extensions: { enable: names } }),
    )
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  }
  // Before the canvas runs: Luna says one conversation needs input, another is done.
  await enable([])
  const before = await fauxServer(options)
  offerLuna(before.host.modelRuntime)
  const registry = before.host.registry
  registry.install(
    defineExtension({
      ...registry.snapshot().extension('conversations')!,
      ...summaryBehavior(
        {
          harness: () => before.harness,
          metadata: Metadata,
          userHome: before.host.userHome,
          projectSettings: async () => ({}),
          notice: () => {},
          modelRuntime: before.host.modelRuntime,
        },
        async (_models, input) => ({
          assessment: /\?\s*$/.test(input) ? 'needs_input' : 'done',
          activity: 'Answered.',
          title: 'A question',
          summary: 'Answered.',
        }),
      ),
    }),
  )
  script(
    before,
    [fauxAssistantMessage('Which database should I use?'), fauxAssistantMessage('Tidied up.')],
    () => fauxAssistantMessage('Unused.'),
  )
  const assessed = async (id: number) =>
    (await before.harness.snapshot(Summaries, id as ConversationId, context))?.assessment?.value
  await post(before, '/api/conversations/1/submit', { text: 'Pick a database' })
  await until(async () => (await assessed(1)) === 'needs_input')
  const other = (await post(before, '/api/conversations', {})).data.id as number
  await post(before, `/api/conversations/${other}/submit`, { text: 'Tidy up' })
  await until(async () => (await assessed(other)) === 'done')
  await before.close()

  // The canvas opens with Luna available: the decision shows, and nothing old is concluded.
  await enable(['canvas'])
  const prepared = await prepareFauxServer(options)
  offerLuna(prepared.host.modelRuntime)
  const generated = vi.fn<typeof generateConclusion>()
  const canvas = prepared.host.registry
  canvas.install(
    defineExtension({
      ...canvas.snapshot().extension('canvas')!,
      ...conclusionBehavior(
        {
          harness: () => server.harness,
          metadata: Metadata,
          userHome: home,
          projectSettings: async () => ({}),
          notice: () => {},
          modelRuntime: prepared.host.modelRuntime,
        },
        generated,
      ),
    }),
  )
  const server: Server = { ...prepared, ...(await prepared.go()) }
  const close = server.close.bind(server)
  server.close = async () => {
    await server.vite.watcher.close()
    await close()
  }
  servers.push(server)
  const tree = async (id: number) =>
    (await server.harness.snapshot(Canvas, ROOT_CONVERSATION_ID, context))?.trees[id]
  await until(async () => (await tree(1))?.decision !== undefined, 30000)
  expect((await tree(1))?.decision?.reasons).toEqual([
    { kind: 'needs_input', conversationId: 1, detail: 'needs input' },
  ])
  await quietly()
  expect(await tree(other)).toBeUndefined()
  expect(generated).not.toHaveBeenCalled()
  expect(await conclusionTasks(server)).toEqual([])
}, 90000)

it('marks the conclusion stale on new work, and the next quiet replaces it', async () => {
  const fixture = await launch()
  const { server } = fixture
  script(
    server,
    [
      fauxAssistantMessage('First answer.'),
      fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Second answer.'),
    ],
    () => fauxAssistantMessage('Unused.'),
  )
  await post(server, '/api/conversations/1/submit', { text: 'First' })
  await until(async () => (await fixture.tree(1))?.conclusion !== undefined, 30000)
  const first = (await fixture.tree(1))!.conclusion!

  await post(server, '/api/conversations/1/submit', { text: 'Second' })
  await until(async () => (await fixture.tree(1))?.conclusion?.stale === true, 30000)
  await until(async () => (await fixture.tree(1))?.conclusion?.stale === undefined, 30000)
  const second = (await fixture.tree(1))!.conclusion!
  expect(second.through).toBeGreaterThan(first.through)
  expect(second.at).toBeGreaterThan(first.at)
  expect(fixture.generated).toHaveBeenCalledTimes(2)
  expect(fixture.generated.mock.calls[1][1]).toContain('user: Second')
}, 90000)

it('concludes a tree with many screenshots a page at a time, keeping only the newest screenshot', async () => {
  const fixture = await launch({ repository: true })
  const { server } = fixture
  // Each screenshot is one pixel wider than the one before, so the thumbnail tells which one it shows.
  let shots = 0
  const registry = server.host.registry
  registry.install(
    defineExtension({
      name: 'test-screenshot',
      tools: [
        defineTool({
          name: 'screenshot',
          description: 'Screenshot the UI',
          parameters: Type.Object({}),
          execute: async () => ({
            output: [
              {
                type: 'image' as const,
                mimeType: 'image/png',
                data: png(100 + ++shots, 40).toString('base64'),
              },
              { type: 'text' as const, text: 'Title: Demo' },
            ],
          }),
        }),
      ],
    }),
  )
  const paged = paging(server.harness)
  registry.install(
    defineExtension({
      ...registry.snapshot().extension('canvas')!,
      ...conclusionBehavior(
        {
          harness: () => paged.harness,
          metadata: Metadata,
          userHome: fixture.home,
          projectSettings: async () => ({}),
          notice: () => {},
          modelRuntime: fixture.server.host.modelRuntime,
        },
        fixture.generated,
      ),
    }),
  )
  // Twelve screenshots, a note written with every fourth, and a fix committed in between.
  const steps = Array.from({ length: 12 }, (_, index) => [
    call('screenshot', {}),
    ...(index % 4 === 0 ? [call('write', { path: `notes-${index}.txt`, content: 'Seen.\n' })] : []),
  ]).flat()
  steps.splice(
    7,
    0,
    call('write', { path: 'bug.txt', content: 'fixed\n' }),
    call('bash', { command: 'git commit -am "Fix the bug"' }),
  )
  script(server, [...steps, fauxAssistantMessage('Looked at it twelve times.')], () =>
    fauxAssistantMessage('Unused.'),
  )
  let checkpoint: unknown
  fixture.generated.mockImplementationOnce(async (_models, input, signal, receipt) => {
    checkpoint = (await conclusionTasks(server))[0].state
    return generateConclusion(fixture.provider.models, input, signal, receipt)
  })
  await post(server, '/api/conversations/1/submit', { text: 'Look at the UI' })
  await until(async () => (await fixture.tree(1))?.conclusion !== undefined, 60000)

  // Every page was done with before the next was read.
  expect(paged.pages()).toBeGreaterThan(10)
  expect([...paged.late]).toEqual([])
  // Between collecting and asking Luna, the task keeps the newest screenshot's place, and no image.
  const { items } = await server.harness.commit(
    (tx) => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100),
    context,
  )
  const newest = items.find(
    (entry) => entry.model?.[0]?.role === 'toolResult' && entry.model[0].toolName === 'screenshot',
  )!
  expect(checkpoint).toMatchObject({
    checkpoint: { phase: 'generate', artifacts: { screenshot: { entry: newest.id, index: 0 } } },
  })
  // `iVBORw0KGgo` starts every PNG in base64.
  expect(JSON.stringify(checkpoint)).not.toContain('iVBORw0KGgo')
  // Calls and results read pages apart still count, oldest first.
  const full = (await fixture.full(1))!
  expect(shots).toBe(12)
  expect(full.thumbnail).toMatchObject({ width: 112, height: 40 })
  expect(full.files).toEqual(['notes-0.txt', 'notes-4.txt', 'bug.txt', 'notes-8.txt'])
  expect(full.commits).toMatchObject([{ subject: 'Fix the bug', branch: 'main' }])
  expect((await fixture.tree(1))?.conclusion).toMatchObject({
    screenshot: true,
    files: 4,
    commits: 1,
  })
}, 90000)

it('drops an archived tree from the root document, shows its conclusion again once unarchived, and prunes on open', async () => {
  const fixture = await launch()
  script(fixture.server, [fauxAssistantMessage('Done.')], () => fauxAssistantMessage('Unused.'))
  await post(fixture.server, '/api/conversations/1/submit', { text: 'Work' })
  await until(async () => (await fixture.tree(1))?.conclusion !== undefined, 30000)
  const concluded = (await fixture.tree(1))!

  // Archived, the tree leaves the document every tab loads; its conclusion stays with the conversation.
  await archive(fixture.server, [1])
  await until(async () => (await fixture.tree(1)) === undefined)
  expect((await fixture.full(1))?.headline).toBe('Fixed the bug and landed it')

  // Unarchived, the stored conclusion shows again, without asking Luna again.
  await archive(fixture.server, [])
  await until(async () => (await fixture.tree(1))?.conclusion !== undefined)
  expect(await fixture.tree(1)).toEqual(concluded)
  await quietly()
  expect(fixture.generated).toHaveBeenCalledTimes(1)

  // Entries left for trees that are not on the map, as when one was archived while the canvas was off, or for an id
  // that is no conversation, go when the canvas opens.
  await archive(fixture.server, [1])
  await until(async () => (await fixture.tree(1)) === undefined)
  await fixture.server.harness.commit(async (tx) => {
    const { trees } = await tx.doc(Canvas, ROOT_CONVERSATION_ID)
    trees['1'] = concluded
    trees['999'] = concluded
  }, context)
  await fixture.reopen()
  await until(
    async () =>
      Object.keys(
        (await fixture.server.harness.snapshot(Canvas, ROOT_CONVERSATION_ID, context))?.trees ?? {},
      ).length === 0,
  )
  expect(fixture.notices).toEqual([])
}, 90000)

it('stays quiet without Luna: no task, no conclusion and no notices', async () => {
  const fixture = await launch({ available: false })
  const { server } = fixture
  script(server, [fauxAssistantMessage('Done.')], () => fauxAssistantMessage('Unused.'))
  await post(server, '/api/conversations/1/submit', { text: 'Work' })
  await until(() => server.api.conversations().some((summary) => summary.answerAt))
  await quietly()
  expect(fixture.generated).not.toHaveBeenCalled()
  expect(await conclusionTasks(server)).toEqual([])
  expect(await fixture.tree(1)).toBeUndefined()
  expect(await server.harness.snapshot(Conclusions, ROOT_CONVERSATION_ID, context)).toBeUndefined()
  expect(await fixture.full(1)).toBeNull()
  expect(fixture.notices).toEqual([])
}, 60000)

it('survives a crash after Luna answered: the stored response is used, not requested again', async () => {
  const fixture = await launch()
  let crashed!: () => void
  const crashing = new Promise<void>((done) => {
    crashed = done
  })
  // The response arrives and is stored, then the process goes away before the conclusion is.
  fixture.generated.mockImplementationOnce((_models, input, signal, receipt) =>
    generateConclusion(fixture.provider.models, input, signal, {
      model: receipt.model,
      save: async (response) => {
        await receipt.save!(response)
        crashed()
        return new Promise((_done, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Closed')), { once: true }),
        )
      },
    }),
  )
  script(fixture.server, [fauxAssistantMessage('Done.')], () => fauxAssistantMessage('Unused.'))
  await post(fixture.server, '/api/conversations/1/submit', { text: 'Work' })
  await crashing
  await fixture.reopen()
  await until(async () => (await fixture.tree(1))?.conclusion !== undefined, 30000)
  expect(fixture.generated).toHaveBeenCalledTimes(2)
  expect(fixture.generated.mock.calls[1][3]?.response).toBeDefined()
  expect(fixture.provider.streamSimple).toHaveBeenCalledTimes(1)
  expect((await fixture.tree(1))?.conclusion?.headline).toBe('Fixed the bug and landed it')
  const usage = await fixture.server.harness.snapshot(UsageDoc, ROOT_CONVERSATION_ID, context)
  expect(usage?.models['openai/gpt-6-luna']?.input).toBe(1200)
}, 90000)

it('accepts only a complete conclusion from Luna', async () => {
  const signal = new AbortController().signal
  const ask = (answer: unknown) =>
    generateConclusion(luna(answer as ConclusionText).models, 'Untrusted text', signal, {
      model: { provider: 'openai', id: 'gpt-6-luna', thinking: 'medium' },
    })
  expect(
    await ask({ headline: `  ${'Long headline '.repeat(10)}`, summary: 'Did it.', landed: [] }),
  ).toEqual({
    headline: 'Long headline '.repeat(10).trim().slice(0, 80),
    summary: 'Did it.',
    landed: [],
  })
  for (const answer of [
    { headline: 'Done', summary: 'Did it.' },
    { headline: '', summary: 'Did it.', landed: [] },
    { headline: 'Done', summary: 'Did it.', landed: 'Bug fix' },
    { headline: 'Done', summary: 3, landed: [] },
  ])
    await expect(ask(answer)).rejects.toThrow('Invalid conclusion')
})

it('opens a canvas document stored before trees existed', async () => {
  const home = await temp('ultimate-canvas-upgrade-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  const enable = (names: string[]) =>
    writeFile(
      join(projectRoot, '.ultimate/settings.json'),
      JSON.stringify({ extensions: { enable: names } }),
    )
  const options = {
    ultimateRoot: resolve('.'),
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  }
  await enable([])
  const before = await fauxServer(options)
  const Before = defineDoc<Pick<CanvasState, 'agents'>>({
    kind: 'ultimate.canvas',
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    initial: () => ({ agents: {} }),
  })
  await before.harness.commit(async (tx) => {
    ;(await tx.doc(Before, ROOT_CONVERSATION_ID)).agents['1'] = {
      tools: [],
      edits: [],
      updatedAt: 1,
    }
  }, context)
  await before.close()

  await enable(['canvas'])
  const server = await fauxServer(options)
  servers.push(server)
  const notices: string[] = []
  server.events.listeners.add((name, data) => {
    if (name === 'notice') notices.push((data as { message: string }).message)
  })
  script(server, [fauxAssistantMessage('Done.')], () => fauxAssistantMessage('Unused.'))
  await post(server, '/api/conversations/1/submit', { text: 'Work' })
  await until(
    async () =>
      (await server.harness.snapshot(Canvas, ROOT_CONVERSATION_ID, context))?.agents[1]?.writing
        ?.text === 'Done.',
  )
  expect((await server.harness.snapshot(Canvas, ROOT_CONVERSATION_ID, context))?.trees).toEqual({})
  expect(notices.filter((notice) => notice.startsWith('Canvas'))).toEqual([])
}, 60000)
