import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, JsonObject } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { Summaries, setAutomaticSummaries } from '../extensions/conversations/summary.ts'
import { liveInstructions } from '../extensions/voice-live/server.ts'
import type { VoiceAnswer, VoiceLine } from '../extensions/voice-live/refs.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { fauxServer, held, post, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  const path = join(ultimateRoot, 'extensions/voice-live/agents/voice.md')
  await writeFile(
    path,
    (await readFile(path, 'utf8')).replace('openai-codex/gpt-6-luna', 'faux/faux-1'),
  )
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'unavailable/test', extensions: { enable: ['voice-live'] } }),
  )
})
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()))
})

it.each([false, true])('loads Voice agents and facets only when enabled (%s)', async (enabled) => {
  const home = await temp('ultimate-voice-toggle-')
  const projectRoot = join(home, 'project')
  await mkdir(join(projectRoot, '.ultimate'), { recursive: true })
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { enable: enabled ? ['voice-live'] : [] } }),
  )
  const probe = join(projectRoot, '.ultimate/extensions/probe')
  await mkdir(probe, { recursive: true })
  await writeFile(
    join(probe, 'server.ts'),
    `import { SubagentsApi } from ${JSON.stringify(join(ultimateRoot, 'extensions/subagents/api.ts'))}
export const actions = {
  residents: (_args, { host, signal }) => host.need(SubagentsApi).residents({ signal }),
}
export default { name: 'probe' }
`,
  )
  const server = await fauxServer({ ultimateRoot, projectRoot, home, userHome: home })
  servers.push(server)
  const residents = await post(server, '/api/extensions/probe/actions/residents', { args: null })
  expect([
    residents.status,
    residents.data.error,
    server.extensions.info().find((e) => e.name === 'probe')?.server?.error,
  ]).toEqual([200, undefined, undefined])
  expect(residents.data.result.some((agent: { name: string }) => agent.name === 'voice')).toBe(
    enabled,
  )
  const info = server.extensions.info().find((extension) => extension.name === 'voice-live')!
  expect(info.enabled).toBe(enabled)
  expect(Boolean(info.server)).toBe(enabled)
  const webFacets = Object.keys(
    (await server.vite.ssrLoadModule('virtual:ultimate/web-facets')).loaders,
  )
  expect(webFacets.some((path) => path.includes('/voice-live/'))).toBe(enabled)
  const rootAgent = await server.root.agent(context)
  expect(
    [...rootAgent.tools, ...rootAgent.deferred].some((tool) => tool.name.startsWith('voice_')),
  ).toBe(enabled)
  const definitions = await post(server, '/api/extensions/subagents/actions/definitions', {
    args: null,
  })
  expect(
    definitions.data.result.definitions.some((agent: { name: string }) => agent.name === 'voice'),
  ).toBe(enabled)
  if (!enabled) return
  // Extension-owned definitions stay built-ins, with both overlay scopes and edits read on demand.
  for (const [directory, text] of [
    [join(home, '.ultimate/agents'), 'User voice additions.'],
    [join(projectRoot, '.ultimate/agents'), 'Project voice additions.'],
  ]) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'voice.md'), `---\nname: voice\naddTools: []\n---\n\n${text}\n`)
  }
  const definition = await post(server, '/api/extensions/subagents/actions/definition', {
    args: { name: 'voice' },
  })
  expect(definition.data.result.definition).toMatchObject({
    source: 'builtin',
    instructions: expect.stringContaining('User voice additions.'),
    overlays: [
      join(home, '.ultimate/agents/voice.md'),
      join(projectRoot, '.ultimate/agents/voice.md'),
    ],
  })
  expect(definition.data.result.definition.instructions).toContain('Project voice additions.')
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'voice' },
  })
  expect(standing.status).toBe(200)
  // Retiring a definition preserves its conversation as history, not a standing agent.
  await rm(join(home, '.ultimate/agents/voice.md'))
  await rm(join(projectRoot, '.ultimate/agents/voice.md'))
  await writeFile(
    join(projectRoot, '.ultimate/settings.json'),
    JSON.stringify({ extensions: { disable: ['voice-live'] } }),
  )
  await until(
    async () => !(await server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.voice,
  )
  expect(
    await server.harness.conversation(standing.data.result as ConversationId, context),
  ).toBeDefined()
  const retired = await post(server, '/api/extensions/conversations/actions/conclude', {
    args: { ids: [standing.data.result] },
  })
  expect(retired.status).toBe(200)
})

async function fixture() {
  const home = await temp('ultimate-voice-live-')
  const server = await fauxServer({ ultimateRoot, home, userHome: home })
  servers.push(server)
  const standing = await post(server, '/api/extensions/subagents/actions/standing', {
    args: { name: 'ultimate' },
  })
  expect(standing.status).toBe(200)
  const main = standing.data.result as ConversationId
  await server.harness.commit((tx) => setAutomaticSummaries(tx, main, false), context)
  await until(
    async () =>
      (await post(server, '/api/extensions/automations/actions/list', { args: null })).data.result
        .length > 0,
  )
  await writeSecret(home, 'OPENAI_API_KEY', 'sk-test-not-real')
  const originalFetch = globalThis.fetch
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) =>
    url === 'https://api.openai.com/v1/live/sessions'
      ? Promise.resolve(
          Response.json({
            session: { id: 'fake-live' },
            transport: { type: 'webrtc', sdp: 'fake-answer' },
          }),
        )
      : originalFetch(url, init),
  )
  let voice: ConversationId
  try {
    const result = await post(server, '/api/extensions/voice-live/actions/start', {
      args: { sdp: 'fake-offer' },
    })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    voice = result.data.result.conversation
    const [, request] = fetch.mock.calls.find(
      ([target]) => target === 'https://api.openai.com/v1/live/sessions',
    )!
    expect(JSON.parse(request!.body as string).session.instructions).toBe(liveInstructions())
  } finally {
    fetch.mockRestore()
  }
  const answers: string[] = []
  let answer = 'The tests pass.'
  const call = (name: string, args: JsonObject) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
  const route: FauxResponseFactory = (...args) => {
    const [transcript] = args
    server.host.faux!.appendResponses([route])
    const system = JSON.stringify(transcript.messages.filter((m) => m.role === 'system'))
    const last = transcript.messages.findLast((m) => m.role !== 'system')!
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    if (system.includes('You are the voice in the user')) {
      if (last.role === 'toolResult') return call('voice_say', { text: 'Passing that on.' })
      if (text.startsWith('@ultimate answered')) {
        answers.push(text)
        return call('voice_say', { text: 'The spoken answer. Details are on screen.' })
      }
      if (text.includes('can you hear me'))
        return call('voice_say', { text: 'Yes, I can hear you.' })
      return call('voice_ask_ultimate', {
        request: text.includes('small fix') ? 'Use the small fix.' : 'Please check the tests.',
      })
    }
    if (answer === 'QUESTION')
      return call('message', {
        to: 'user',
        text: 'Which approach?',
        questions: [
          {
            ref: '1',
            text: 'Approach?',
            kind: 'choice',
            options: [
              { key: 'a', label: 'Small fix' },
              { key: 'b', label: 'Rewrite' },
            ],
          },
        ],
      })
    if (answer === 'HOLD') return held(...args)
    return fauxAssistantMessage(answer)
  }
  server.host.faux!.setResponses([route])
  const action = async (name: string, args: unknown) => {
    const result = await post(server, `/api/extensions/voice-live/actions/${name}`, { args })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    return result.data.result
  }
  const entries = (id: ConversationId) =>
    server.harness.commit(
      async (tx) => (await tx.scanEntries({ conversationId: id, order: 'ascending' }, 1000)).items,
      context,
    )
  const waitAnswer = async (count: number) => {
    await until(
      async () =>
        (await entries(voice)).filter(
          (e) => e.kind === 'voice.line' && (e.data as VoiceLine).re !== undefined,
        ).length === count,
    )
    return (await entries(voice))
      .filter((e) => e.kind === 'voice.line' && (e.data as VoiceLine).re !== undefined)
      .at(-1)!
  }
  return {
    server,
    main,
    voice,
    action,
    entries,
    answers,
    waitAnswer,
    setAnswer: (text: string) => {
      answer = text
    },
  }
}

it('delivers a stopped-input notice and agent input with distinct request ids', async () => {
  const f = await fixture()
  f.setAnswer('HOLD')
  await f.action('heard', { text: 'check tests' })
  await until(async () => (await f.entries(f.main)).some((e) => e.kind === 'voice.utterance'))
  await (await f.server.harness.conversation(f.main, context))!.abort(context)
  await until(() => f.answers.length > 0)
  expect(f.answers[0]).toContain('Ultimate did not answer that request.')
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  const forwarded = lines.find((e) => (e.data as VoiceLine).forwarded)!
  expect(lines.find((e) => (e.data as VoiceLine).role === 'notice')?.data).toMatchObject({
    role: 'notice',
    re: forwarded.id,
    text: 'Ultimate was stopped before it answered.',
  })
})

it('answers a connection check itself in the standing Voice conversation, with its relay tools and codemode', async () => {
  const f = await fixture()
  expect((await f.server.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.voice).toBe(
    f.voice,
  )
  const agent = await (await f.server.harness.conversation(f.voice, context))!.agent(context)
  expect(agent.tools.map((t) => t.name).toSorted()).toEqual([
    'codemode',
    'voice_ask_ultimate',
    'voice_note',
    'voice_say',
  ])
  expect((await f.server.harness.snapshot(Summaries, f.voice, context))?.automatic).toBe(false)
  await f.action('heard', { text: 'can you hear me' })
  await until(async () => (await f.entries(f.voice)).some((e) => e.kind === 'voice.line'))
  await (await f.server.harness.conversation(f.voice, context))!.waitForIdle(context)
  const lines = (await f.entries(f.voice)).filter((e) => e.kind === 'voice.line')
  expect(lines.map((e) => e.data)).toEqual([
    { role: 'ultimate', text: 'Yes, I can hear you.', speech: true },
  ])
  expect((await f.entries(f.voice)).find((e) => e.kind === 'voice.heard')?.data).toEqual({
    text: 'can you hear me',
  })
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(0)
})

it('forwards the cleaned request and feeds the actual answer back to Voice to speak, linked to its forwarded line', async () => {
  const f = await fixture()
  await f.action('heard', { text: 'Um please, can you check the tests for me' })
  const spoken = await f.waitAnswer(1)
  const forwarded = (await f.entries(f.voice)).find(
    (e) => e.kind === 'voice.line' && (e.data as VoiceLine).forwarded,
  )!
  expect(forwarded.data).toEqual({
    role: 'user',
    forwarded: true,
    text: 'Please check the tests.',
    at: expect.any(Number),
  })
  expect((await f.entries(f.main)).find((e) => e.kind === 'voice.utterance')?.data).toEqual({
    text: 'Please check the tests.',
    line: forwarded.id,
  })
  expect(f.answers).toEqual([
    `@ultimate answered (to forwarded line ${forwarded.id}):\nThe tests pass.`,
  ])
  // The card's "Open in @ultimate" lands on the answer itself.
  const answer = (await f.entries(f.voice)).find((e) => e.kind === 'voice.answer')!
  const source = (answer.data as VoiceAnswer).source!
  expect(source.conversation).toBe(f.main)
  expect((await f.entries(f.main)).find((e) => e.id === source.entry)?.kind).toBe('pi.assistant')
  expect(spoken.data).toEqual({
    role: 'ultimate',
    text: 'The spoken answer. Details are on screen.',
    speech: true,
    re: forwarded.id,
  })
  await f.action('end', { seconds: 23 })
  expect((await f.entries(f.voice)).at(-1)?.data).toMatchObject({ phase: 'ended', seconds: 23 })
})

it('speaks a tool-terminated question and answers it through Messages, without a new utterance', async () => {
  const f = await fixture()
  f.setAnswer('QUESTION')
  await f.action('heard', { text: 'Please propose an approach' })
  await f.waitAnswer(1)
  const log = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
  const question = log.messages.findLast((m) => m.from === f.main && m.to === 'user')!
  expect(question.state).toBe('delivered')
  expect(f.answers[0]).toContain('Which approach?')
  expect(f.answers[0]).toContain('a: Small fix')
  expect(f.answers[0]).toContain('b: Rewrite')
  f.setAnswer('I will use the small fix.')
  await f.action('heard', { text: 'The small fix please' })
  await f.waitAnswer(2)
  expect(f.answers[1]).toContain('I will use the small fix.')
  expect(
    (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages.find(
      (m) => m.id === question.id,
    )?.state,
  ).toBe('answered')
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(1)
  expect((await f.entries(f.main)).some((e) => e.kind === 'board.message')).toBe(true)
})
