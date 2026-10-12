import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { Usage } from '@earendil-works/pi-ai'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { DocumentWatch } from '@earendil-works/pi-durable'
import { afterEach, expect, it } from 'vitest'
import { attach, fauxServer, post, temp, until } from './helpers.ts'
import { context } from '../server/harness.ts'
import { Canvas } from '../extensions/canvas/server.ts'
import type { CanvasAgent, CanvasState } from '../extensions/canvas/types.ts'

type Server = Awaited<ReturnType<typeof fauxServer>>
const servers: Server[] = []
const watches: DocumentWatch<CanvasState>[] = []
afterEach(async () => {
  for (const watch of watches.splice(0)) await watch.stop()
  for (const server of servers.splice(0)) await server.close()
})

async function launch(
  enable = ['canvas', 'subagents'],
  home?: string,
  ultimateRoot = resolve('.'),
) {
  home ??= await temp('ultimate-canvas-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable } }),
  )
  const server = await fauxServer({
    ultimateRoot,
    projectRoot,
    userHome: home,
    home: join(home, 'state'),
  })
  servers.push(server)
  return { server, home, projectRoot }
}

/** Every committed revision of the canvas, as a subscriber receives them. */
async function observe(server: Server) {
  await server.harness.commit(async (tx) => {
    await tx.doc(Canvas, ROOT_CONVERSATION_ID)
  }, context)
  const watch = (await server.harness.watchDoc(Canvas, ROOT_CONVERSATION_ID, context))!
  watches.push(watch)
  const revisions = [{ at: Date.now(), value: watch.value! }]
  watch.start(async (value) => {
    revisions.push({ at: Date.now(), value: value! })
  })
  return {
    revisions,
    rows: (id: number) => revisions.flatMap(({ value }) => value.agents[id] ?? []),
    agent: (id: number): CanvasAgent | undefined => revisions.at(-1)!.value.agents[id],
  }
}

const submit = (server: Server, id: number, text: string) =>
  post(server, `/api/conversations/${id}/submit`, { text })
const shape = (agent: CanvasAgent | undefined) =>
  agent && {
    tools: agent.tools.map(({ name, label, status }) => ({ name, label, status })),
    thinking: agent.thinking?.text,
    writing: agent.writing?.text,
    edits: agent.edits.map(({ path, added, removed }) => ({ path, added, removed })),
    waitingOn: agent.waitingOn,
  }

it('shows tools running, then done or failed, and edits with their line counts', async () => {
  const { server, projectRoot } = await launch()
  const notes = join(projectRoot, 'notes.txt')
  await writeFile(notes, 'one\ntwo\nthree\n')
  await writeFile(join(projectRoot, 'guide.txt'), 'one\ntwo\nthree\n')
  const canvas = await observe(server)
  const stream = await attach(server, '?conversation=1&docs=ultimate.canvas')
  server.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 0.8; echo slept' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage(
      [
        fauxToolCall('read', { path: join(projectRoot, 'guide.txt'), offset: 2, limit: 2 }),
        fauxToolCall('read', { path: join(projectRoot, 'missing.txt') }),
        fauxToolCall('edit', { path: notes, edits: [{ oldText: 'two', newText: 'TWO\nTWO-b' }] }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Edited the notes.'),
  ])
  await submit(server, 1, 'go')
  await until(() => canvas.agent(1)?.writing?.text === 'Edited the notes.')

  const bash = canvas.rows(1).map((row) => row.tools.find((tool) => tool.name === 'bash')?.status)
  expect(bash).toContain('running')
  expect(bash.at(-1)).toBe('done')
  expect(shape(canvas.agent(1))).toEqual({
    tools: [
      { name: 'bash', label: '$ sleep 0.8; echo slept', status: 'done' },
      { name: 'read', label: 'read guide.txt:2-3', status: 'done' },
      { name: 'read', label: 'read missing.txt', status: 'error' },
      { name: 'edit', label: 'edit notes.txt', status: 'done' },
    ],
    thinking: undefined,
    writing: 'Edited the notes.',
    edits: [{ path: 'notes.txt', added: 2, removed: 1 }],
    waitingOn: undefined,
  })

  // One root-conversation subscription carries the same document.
  await until(() => {
    let value: CanvasState | undefined
    for (const event of stream.events) {
      const data = event.data as { kind?: string; value?: CanvasState; ops?: Op[] }
      if (data.kind !== 'ultimate.canvas') continue
      if (event.name === 'doc') value = data.value
      if (event.name === 'docOps' && value) value = applyImmutable(value, data.ops!)
    }
    return JSON.stringify(value) === JSON.stringify(canvas.revisions.at(-1)!.value)
  })
  await stream.close()
}, 60000)

it('streams the tails of thinking and writing, at most about four commits a second', async () => {
  const { server } = await launch()
  const canvas = await observe(server)
  const thinking = Array.from({ length: 50 }, (_, index) => `Thought ${index} weighs it.`).join(' ')
  const answer = Array.from({ length: 80 }, (_, index) => `Sentence ${index} answers.`).join(' ')
  server.host.faux!.setResponses([fauxAssistantMessage([fauxThinking(thinking), fauxText(answer)])])
  await submit(server, 1, 'think')
  await until(() => canvas.agent(1)?.writing?.text.endsWith('Sentence 79 answers.') === true)

  const final = canvas.agent(1)!
  expect(final.thinking!.text).toBe(`…${thinking.slice(-239)}`)
  expect(final.writing!.text).toBe(`…${answer.slice(-399)}`)
  // While streaming, the row held the tail of what had arrived so far.
  const rows = canvas.rows(1)
  const thinkingSoFar = rows.filter((row) => row.thinking && !row.writing)
  const writingSoFar = rows.filter((row) => row.writing && row.writing.text !== final.writing!.text)
  expect(thinkingSoFar.length).toBeGreaterThan(1)
  expect(writingSoFar.length).toBeGreaterThan(1)
  for (const row of thinkingSoFar) {
    expect(row.thinking!.text.length).toBeLessThanOrEqual(240)
    expect(thinking).toContain(row.thinking!.text.replace(/^…/, ''))
  }
  for (const row of writingSoFar) {
    expect(row.writing!.text.length).toBeLessThanOrEqual(400)
    expect(answer).toContain(row.writing!.text.replace(/^…/, ''))
  }
  // Coalesced: the provider streamed hundreds of chunks, the document took a commit per quarter second.
  const commits = canvas.revisions.filter(({ value }) => value.agents[1])
  const span = commits.at(-1)!.at - commits[0].at
  expect(span).toBeGreaterThan(1000)
  expect(commits.length).toBeLessThanOrEqual(Math.ceil(span / 250) + 2)
}, 60000)

it('lists the child a parent waits on until the wait ends', async () => {
  const { server } = await launch()
  const canvas = await observe(server)
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const route: FauxResponseFactory = async (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'user' && last.content === 'delegate')
      return fauxAssistantMessage(
        [fauxToolCall('subagent', { action: 'start', agent: 'scout', task: 'Count the files.' })],
        { stopReason: 'toolUse' },
      )
    if (last.role === 'user' && last.content === 'Count the files.') {
      await gate
      return fauxAssistantMessage('Twelve files.')
    }
    return fauxAssistantMessage('Done.')
  }
  server.host.faux!.setResponses([route])
  await submit(server, 1, 'delegate')
  await until(() => server.api.conversations().some((summary) => summary.label === 'scout'))
  const child = server.api.conversations().find((summary) => summary.label === 'scout')!.id
  await until(() => canvas.agent(1)?.waitingOn?.[0] === child)
  expect(canvas.agent(1)!.tools).toEqual([
    expect.objectContaining({
      name: 'subagent',
      label: 'start scout: Count the files.',
      status: 'running',
    }),
  ])

  release()
  await until(() => canvas.agent(1)?.writing?.text === 'Done.')
  expect(canvas.agent(1)!.waitingOn).toBeUndefined()
  expect(canvas.agent(1)!.tools[0].status).toBe('done')
  expect(canvas.agent(child)!.writing!.text).toBe('Twelve files.')
}, 60000)

it('rebuilds the feed from stored entries when it opens, then follows new work', async () => {
  const { server, home, projectRoot } = await launch([])
  server.host.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking('Plan the write.'),
        fauxToolCall('write', { path: join(projectRoot, 'out.txt'), content: 'a\nb\nc\n' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Wrote three lines.'),
  ])
  await submit(server, 1, 'write')
  await until(
    () => server.api.conversations().find((summary) => summary.id === 1)?.answerAt !== undefined,
  )
  await server.harness.waitForIdle(context)
  await server.close()
  servers.splice(0)

  // The work happened without the extension; reopened with it, the row is rebuilt from what was stored.
  const reopened = (await launch(['canvas'], home, server.host.ultimateRoot)).server
  const stored = await reopened.harness.snapshot(Canvas, ROOT_CONVERSATION_ID, context)
  expect(shape(stored?.agents[1])).toEqual({
    tools: [{ name: 'write', label: 'write out.txt', status: 'done' }],
    thinking: 'Plan the write.',
    writing: 'Wrote three lines.',
    edits: [{ path: 'out.txt', added: 3, removed: 0 }],
    waitingOn: undefined,
  })

  const canvas = await observe(reopened)
  reopened.host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'echo again' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Ran it again.'),
  ])
  await submit(reopened, 1, 'again')
  await until(() => canvas.agent(1)?.writing?.text === 'Ran it again.')
  expect(shape(canvas.agent(1))!.tools).toEqual([
    { name: 'write', label: 'write out.txt', status: 'done' },
    { name: 'bash', label: '$ echo again', status: 'done' },
  ])
}, 60000)

it('drops archived conversations and their subagents, and rebuilds them when unarchived', async () => {
  const { server } = await launch()
  const canvas = await observe(server)
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const last = transcript.messages.findLast((message) => message.role !== 'system')!
    if (last.role === 'user' && last.content === 'delegate')
      return fauxAssistantMessage(
        [fauxToolCall('subagent', { action: 'start', agent: 'scout', task: 'Look around.' })],
        { stopReason: 'toolUse' },
      )
    if (last.role === 'user' && last.content === 'Look around.')
      return fauxAssistantMessage('Looked.')
    return fauxAssistantMessage('Delegated.')
  }
  server.host.faux!.setResponses([route])
  const other = (await post(server, '/api/conversations', {})).data.id as number
  await submit(server, other, 'delegate')
  await until(() => canvas.agent(other)?.writing?.text === 'Delegated.')
  const child = server.api
    .conversations()
    .find((summary) => summary.parentConversationId === other)!.id
  await until(() => canvas.agent(child)?.writing?.text === 'Looked.')

  await post(server, '/api/ui', { set: { 'ext.conversations.archived': [other] } })
  await until(() => !canvas.agent(other) && !canvas.agent(child))

  await post(server, '/api/ui', { set: { 'ext.conversations.archived': [] } })
  await until(() => canvas.agent(other) !== undefined && canvas.agent(child) !== undefined)
  expect(shape(canvas.agent(other))).toEqual({
    tools: [{ name: 'subagent', label: 'start scout: Look around.', status: 'done' }],
    thinking: undefined,
    writing: 'Delegated.',
    edits: [],
    waitingOn: undefined,
  })
  expect(canvas.agent(child)!.writing!.text).toBe('Looked.')
}, 60000)

it('keeps each agent’s model, context and spend, updates them, and forgets the context after a reset', async () => {
  const { server } = await launch()
  const canvas = await observe(server)
  await post(server, '/api/conversations/1/configure', {
    model: { provider: 'faux', modelId: 'faux-1' },
  })
  server.host.faux!.setResponses([
    fauxAssistantMessage('First answer.'),
    fauxAssistantMessage('A second, longer answer to a longer conversation.'),
  ])
  await submit(server, 1, 'one')
  await until(
    () => canvas.agent(1)?.writing?.text === 'First answer.' && !!canvas.agent(1)?.usage?.output,
  )
  const first = canvas.agent(1)!.usage!
  expect(first).toMatchObject({ provider: 'faux', model: 'faux-1' })
  expect(first.input).toBeGreaterThan(0)
  expect(first.context).toBeGreaterThan(0)

  await submit(server, 1, 'two')
  await until(() => canvas.agent(1)?.writing?.text.startsWith('A second') === true)
  await until(() => canvas.agent(1)!.usage!.input > first.input)
  const second = canvas.agent(1)!.usage!
  expect(second.output).toBeGreaterThan(first.output)
  // The context is what the latest answer's prompt took, as the status line counts it.
  const latest = await server.harness.commit(
    async (tx) =>
      (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 8)).items.find(
        (entry) => entry.kind === 'pi.assistant',
      ),
    context,
  )
  const prompt = (latest!.model![0] as { usage: Usage }).usage
  expect(second.context).toBe(prompt.input + prompt.cacheRead + prompt.cacheWrite)
  expect(second.context).not.toBe(first.context)

  await server.harness.waitForIdle(context)
  expect(
    (await post(server, '/api/extensions/conversations/actions/reset', { args: { id: 1 } })).status,
  ).toBe(200)
  await until(() => canvas.agent(1)?.usage?.context === undefined)
  // The spend stays: it was paid.
  expect(canvas.agent(1)!.usage).toMatchObject({ input: second.input, output: second.output })
}, 60000)
