import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { context } from '../server/harness.ts'
import { Metadata } from '../server/metadata.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Summaries, setAutomaticSummaries } from '../extensions/conversations/summary.ts'
import { CONFIRM, Voice, liveInstructions } from '../extensions/voice-live/server.ts'
import type { VoiceLine } from '../extensions/voice-live/refs.ts'
import { SPEECH_PROMPT, speakable } from '../extensions/voice-live/speech.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import { fauxServer, post, sourceCopy, temp, until } from './helpers.ts'

let ultimateRoot: string
const servers: Awaited<ReturnType<typeof fauxServer>>[] = []
beforeAll(async () => {
  ultimateRoot = await sourceCopy(await temp())
  await writeFile(
    join(ultimateRoot, '.ultimate/settings.json'),
    JSON.stringify({ summaryModel: 'faux/faux-1' }),
  )
})
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()))
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
  let start: { sdp: string; conversation: number }
  try {
    const result = await post(server, '/api/extensions/voice-live/actions/start', {
      args: { sdp: 'fake-offer' },
    })
    expect([result.status, result.data.error]).toEqual([200, undefined])
    start = result.data.result
    expect(start.sdp).toBe('fake-answer')
    const [url, request] = fetch.mock.calls.find(
      ([target]) => target === 'https://api.openai.com/v1/live/sessions',
    )!
    expect(url).toBe('https://api.openai.com/v1/live/sessions')
    expect(JSON.parse(request!.body as string)).toEqual({
      session: {
        model: 'gpt-live-1',
        instructions: liveInstructions(CONFIRM),
        audio: { output: { voice: 'marin' } },
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp: 'fake-offer' },
    })
  } finally {
    fetch.mockRestore()
  }
  const voice = start.conversation as ConversationId
  const rewrites: string[] = []
  let answer = 'The tests pass.'
  const route: FauxResponseFactory = (transcript) => {
    server.host.faux!.appendResponses([route])
    const system = JSON.stringify(transcript.messages.filter((m) => m.role === 'system'))
    if (system.includes(SPEECH_PROMPT.slice(0, 80))) {
      rewrites.push(JSON.stringify(transcript.messages))
      return fauxAssistantMessage('The fix is ready. Details are on screen.')
    }
    if (answer === 'QUESTION')
      return fauxAssistantMessage(
        [
          fauxToolCall('message', {
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
          }),
        ],
        { stopReason: 'toolUse' },
      )
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
  const spoken = async () =>
    (await entries(voice)).filter(
      (e) => e.kind === 'voice.line' && (e.data as VoiceLine).role === 'ultimate',
    )
  const waitSpoken = async (count: number) => {
    await until(async () => (await spoken()).length === count)
    return (await spoken()).at(-1)!
  }
  return {
    server,
    main,
    voice,
    rewrites,
    action,
    entries,
    waitSpoken,
    setAnswer: (text: string) => {
      answer = text
    },
  }
}

it('starts an ownerless passive log, submits custom utterances, and speaks short answers verbatim', async () => {
  const f = await fixture()
  expect(
    (await f.server.harness.snapshot(Voice, ROOT_CONVERSATION_ID, context))?.conversation,
  ).toBe(f.voice)
  const info = await f.server.harness.commit(
    async (tx) => ({
      conversation: await tx.conversation(f.voice),
      metadata: { ...(await tx.doc(Metadata, f.voice)) },
    }),
    context,
  )
  expect(info.conversation).toBeDefined()
  expect(info.conversation?.owner).toBeUndefined()
  expect(info.metadata).toMatchObject({ title: 'Voice', label: 'voice' })
  expect((await f.server.harness.snapshot(Summaries, f.voice, context))?.automatic).toBe(false)
  expect((await f.entries(f.voice)).find((e) => e.kind === 'voice.session')?.data).toMatchObject({
    phase: 'started',
  })
  const { line } = await f.action('say', { text: 'Please check the tests', delegation: 'd1' })
  const spoken = await f.waitSpoken(1)
  const utterance = (await f.entries(f.main)).find((e) => e.kind === 'voice.utterance')!
  expect(utterance.data).toEqual({ text: 'Please check the tests', line })
  expect(utterance.model).toMatchObject([
    {
      role: 'user',
      content: 'Daniel, by voice (live transcript, may contain mistakes):\nPlease check the tests',
    },
  ])
  expect((await f.entries(f.voice)).find((e) => e.id === line)?.data).toEqual({
    role: 'daniel',
    text: 'Please check the tests',
    delegation: 'd1',
    forwarded: true,
  })
  // Small talk stays in Voice: logged, never an input to @ultimate.
  await f.action('log', { role: 'daniel', text: 'Can you hear me?' })
  await f.action('log', { role: 'live', text: 'Yes, loud and clear.' })
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(1)
  expect(spoken.data).toMatchObject({
    role: 'ultimate',
    text: 'The tests pass.',
    speech: true,
    delegation: 'd1',
    source: { conversation: f.main },
  })
  expect(f.rewrites).toEqual([])
  expect((await f.entries(f.voice)).every((e) => !e.model?.length)).toBe(true)
  await f.action('end', { seconds: 23 })
  expect((await f.entries(f.voice)).at(-1)?.data).toMatchObject({ phase: 'ended', seconds: 23 })
})

it('rewrites a Markdown answer through the configured faux summary model', async () => {
  const f = await fixture()
  f.setAnswer('**Fixed** the issue in `extensions/voice-live/server.ts`.\n\nRun `pnpm check`.')
  await f.action('say', { text: 'Please fix the issue' })
  expect((await f.waitSpoken(1)).data).toMatchObject({
    text: 'The fix is ready. Details are on screen.',
    speech: true,
  })
  expect(f.rewrites).toHaveLength(1)
  expect(f.rewrites[0]).toContain('pnpm check')
})

it('speaks a tool-terminated question and answers the open question by voice, without a new utterance input', async () => {
  const f = await fixture()
  f.setAnswer('QUESTION')
  await f.action('say', { text: 'Please propose an approach' })
  await f.waitSpoken(1)
  const log = (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))!
  const question = log.messages.findLast((m) => m.from === f.main && m.to === 'user')!
  expect(question.state).toBe('delivered')
  expect(f.rewrites[0]).toContain('Which approach?')
  expect(f.rewrites[0]).toContain('a: Small fix')
  expect(f.rewrites[0]).toContain('b: Rewrite')
  f.setAnswer('I will use the small fix.')
  await f.action('say', { text: 'The small fix please' })
  expect((await f.waitSpoken(2)).data).toMatchObject({
    text: 'I will use the small fix.',
    source: { conversation: f.main },
  })
  expect(
    (await f.server.harness.snapshot(Messages, ROOT_CONVERSATION_ID, context))?.messages.find(
      (m) => m.id === question.id,
    )?.state,
  ).toBe('answered')
  expect((await f.entries(f.main)).filter((e) => e.kind === 'voice.utterance')).toHaveLength(1)
  expect((await f.entries(f.main)).some((e) => e.kind === 'board.message')).toBe(true)
})

it('strips structured content when no summary model is available', async () => {
  expect(
    await speakable('**Done**. See `src/main.ts` and https://example.com.', async () => undefined),
  ).toContain('Details are on screen.')
  expect(
    await speakable('**Done**. See `src/main.ts` and https://example.com.', async () => undefined),
  ).not.toMatch(/[`*]|https|src\//)
})
