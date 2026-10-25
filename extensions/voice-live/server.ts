import { BACKGROUND_CONTEXT as context, awaitWithContext } from '@earendil-works/chord/context'
import {
  AssistantEntry,
  defineDoc,
  defineExtension,
  defineTask,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { ConversationsApi } from '../conversations/api.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import type { SummaryModel } from '../conversations/summary-model.ts'
import { Messages, MessagesApi } from '../messages/api.ts'
import type { Question } from '../messages/api.ts'
import { Standing } from '../subagents/api.ts'
import { EndAction, SayAction, StartAction, StatusAction, VoiceDoc } from './refs.ts'
import type { VoiceLine, VoiceSession, VoiceState } from './refs.ts'
import { speakable } from './speech.ts'

const SECRET = 'OPENAI_API_KEY'
const NO_KEY = `Live voice needs an OpenAI API key: add ${SECRET} in ⌘K → Secrets`
export const secrets = [
  {
    name: SECRET,
    description: 'OpenAI API key for live voice',
    url: 'https://platform.openai.com/api-keys',
  },
]

/** The same API-key-only policy as composer voice; an OpenAI OAuth login is not an API key. */
async function apiKey(host: ExtensionHost, signal: AbortSignal) {
  const key = await readSecret(host.userHome, SECRET)
  if (key) return key
  const runtime = host.modelRuntime
  if (!runtime.getProviderAuthStatus('openai').configured || runtime.isUsingOAuth('openai'))
    return undefined
  return (await runtime.getAuth('openai', { signal }))?.auth.apiKey
}

export const LIVE_INSTRUCTIONS = `You are a voice relay between Daniel and Ultimate, a coding agent. Daniel's requests, questions and statements are all for Ultimate, not for you. Speak in Daniel's language.

Backchannel policy
Use only a very short acknowledgement such as "passing that on" or "got it". If asked while waiting, say "still on it". Ask Daniel to repeat only when unintelligible. Keep backchannels minimal.

Interruption policy
Stop speaking and listen when Daniel interrupts.

Delegation policy
Backend tools:
Ultimate handles every request, question and statement. Client commentary supplies its answers.
Generate <|SpawnThinking|> when:
Daniel makes any intelligible request, question or statement for Ultimate.
Do not generate <|SpawnThinking|> when:
You are acknowledging, asking for a repeat, or speaking supplied commentary.
Never answer on your own. Do not guess the result while waiting.
When commentary arrives, say it plainly in Daniel's language without adding content.`

export const Voice = defineDoc<VoiceState>({
  kind: VoiceDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [Voice]
export const userActions = ['status', 'start', 'say', 'end']
const terminal = { status: 'terminal', outcome: { status: 'completed', result: null } } as const

async function voiceId(host: ExtensionHost) {
  const voice = await host.harness().snapshot(Voice, ROOT_CONVERSATION_ID, context)
  if (!voice?.conversation) throw new Error('Start live voice first')
  return voice.conversation as ConversationId
}

async function lines(tx: Tx, id: ConversationId, limit: number) {
  const result: VoiceLine[] = []
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries({ conversationId: id, order: 'descending' }, 100, cursor)
    for (const entry of page.items) {
      if (entry.kind === 'voice.line') result.push(entry.data as VoiceLine)
      if (result.length === limit) return result.toReversed()
    }
    cursor = page.next
  } while (cursor)
  return result.toReversed()
}

/** Display-only writes need no model message and never launch a turn. */
async function write(
  host: ExtensionHost,
  id: ConversationId,
  kind: 'voice.line' | 'voice.session',
  data: VoiceLine | VoiceSession,
  requestId: string,
) {
  const conversation = (await host.harness().conversation(id, context))!
  const settled = await (
    await conversation.submit({ type: 'write', requestId, entry: { kind, data } }, context)
  ).wait(context)
  if (settled.status !== 'done') throw new Error(`Voice write failed: ${settled.reason}`)
  return settled.entry
}

function questionsText(questions: Question[]) {
  return questions
    .map((q, i) =>
      [
        `${q.ref ?? i + 1}. ${q.text}`,
        ...(q.options ?? []).map(
          (o, j) =>
            `${o.key ?? String.fromCharCode(97 + j)}: ${o.label}${o.detail ? ` — ${o.detail}` : ''}`,
        ),
        ...(q.scale
          ? [
              `Scale ${q.scale.min} (${q.scale.low ?? ''}) to ${q.scale.max} (${q.scale.high ?? ''})`,
            ]
          : []),
      ].join('\n'),
    )
    .join('\n\n')
}

const danielLine = (input: { text: string; delegation?: string }): VoiceLine => ({
  role: 'daniel',
  text: input.text,
  ...(input.delegation ? { delegation: input.delegation } : {}),
})

export function answerTask(host: ExtensionHost) {
  const summaries = host.need(ConversationsApi)
  return defineTask<
    {
      voice: number
      main: number
      /** Names Daniel's line: the task and `say` write it once under `voice:line:<request>`. */
      request: string
      text: string
      delegation?: string
      firstMessage: number
    },
    { phase: 'answer' },
    null
  >({
    name: 'voice-live.answer',
    version: 1,
    initial: () => ({ phase: 'answer' }),
    phases: {
      answer: async (task, runtime, ctx) => {
        const input = task.input
        const main = input.main as ConversationId
        const recipient = (await host.harness().conversation(main, ctx))!
        const line = await write(
          host,
          input.voice as ConversationId,
          'voice.line',
          danielLine(input),
          `voice:line:${input.request}`,
        )
        // The open question this utterance answers, chosen once: after our own answer it is no longer open.
        let question = await runtime.memo<number | false>('question', ctx)
        if (question === undefined) {
          const log = await runtime.snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
          const open = log?.messages.findLast(
            (m) => m.from === main && m.to === 'user' && m.reply && m.state === 'delivered',
          )
          question = await runtime.memo('question', open?.id ?? false, ctx)
        }
        let receipt
        // A crash after answer() finds this utterance's own reply by its text, never another answer to the question.
        const log = await runtime.snapshot(Messages, ROOT_CONVERSATION_ID, ctx)
        const previous =
          question === false
            ? undefined
            : log?.messages.find(
                (m) => m.from === 'user' && m.re === question && m.text === input.text,
              )
        const reply =
          question === false
            ? undefined
            : (previous?.id ??
              (await host
                .need(MessagesApi)
                .answer(question, input.text, ctx)
                .catch((error: unknown) => {
                  // Answered meanwhile (its card, another utterance): this utterance goes in as plain voice input.
                  if (
                    error instanceof Error &&
                    error.message === 'These questions are no longer open'
                  )
                    return undefined
                  throw error
                })))
        if (reply !== undefined) {
          const watch = (await runtime.watchDoc(Messages, ROOT_CONVERSATION_ID, ctx))!
          const placed = Promise.withResolvers<void>()
          const inspect = (value: typeof watch.value) => {
            const m = value?.messages.find((candidate) => candidate.id === reply)
            if (m?.entry) placed.resolve()
            else if (m && ['failed', 'stopped'].includes(m.state))
              placed.reject(new Error(m.error ?? 'Voice reply was not delivered'))
          }
          watch.start(async (value) => {
            inspect(value)
          })
          try {
            inspect(watch.value)
            await awaitWithContext(placed.promise, ctx)
          } finally {
            await watch.stop()
          }
          let cursor: Cursor | undefined
          do {
            const page = await host.scanSubmissions({ conversationId: main }, 100, cursor, ctx)
            const found = page.items.find((s) => s.requestId === `board:${reply}`)
            if (found) {
              receipt = await host.harness().submission(found.id, ctx)
              break
            }
            cursor = page.next
          } while (cursor)
          if (!receipt) throw new Error('Voice question reply has no input receipt')
        } else {
          receipt = await recipient.submit(
            {
              type: 'input',
              requestId: `voice:${line}`,
              whenBusy: 'steer',
              entry: { kind: 'voice.utterance', data: { text: input.text, line } },
              content: `Daniel, by voice (live transcript, may contain mistakes):\n${input.text}`,
            },
            ctx,
          )
        }
        const settled = await receipt.wait(ctx)
        if (settled.status !== 'done' || settled.type !== 'input') {
          await runtime.commit(
            () => ({
              status: 'terminal',
              outcome: {
                status: 'failed',
                error: { message: 'Ultimate did not answer the voice input' },
              },
            }),
            ctx,
          )
          return
        }
        const source = await host.harness().commit(async (tx) => {
          const answer = await tx.entry(AssistantEntry, settled.answer)
          const message = answer?.model?.[0]
          const plain =
            message?.role === 'assistant'
              ? message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
              : ''
          // A tool-terminated message can have no final prose. Match calls in this run, not another concurrent run.
          const calls = new Set<string>()
          let cursor: Cursor | undefined
          do {
            const page = await tx.scanEntries(
              {
                conversationId: main,
                minEntryId: settled.entry,
                maxEntryId: settled.answer,
                order: 'ascending',
              },
              100,
              cursor,
            )
            for (const entry of page.items)
              for (const m of entry.model ?? [])
                if (m.role === 'assistant')
                  for (const p of m.content) if (p.type === 'toolCall') calls.add(p.id)
            cursor = page.next
          } while (cursor)
          const sent = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.findLast(
            (m) =>
              m.id >= input.firstMessage &&
              m.from === main &&
              m.to === 'user' &&
              m.call &&
              [...calls].some((call) => m.call === call || m.call!.startsWith(`${call}/`)),
          )
          return sent
            ? `${sent.text}${sent.questions?.length ? `\n\nQuestions:\n${questionsText(sent.questions)}` : ''}`
            : plain
        }, ctx)
        let text = await runtime.memo<string>('speech', ctx)
        if (text === undefined) {
          text = await speakable(source, async (prompt, content) => {
            let model = await runtime.memo<SummaryModel | false>('model', ctx)
            if (model === undefined)
              model = await runtime.memo('model', (await summaries.summaryModel()) ?? false, ctx)
            if (!model) return undefined
            const response = await summaries.askSummaryModel(
              runtime.models,
              prompt,
              content,
              runtime.signal,
              {
                model,
                response: await runtime.memo<ResponseReceipt>('response', ctx),
                save: (answer) => runtime.memo('response', answer, ctx),
              },
            )
            if (!['stop', 'length'].includes(response.stopReason))
              throw new Error(`Speech rewrite failed: ${response.stopReason}`)
            return response.text
          })
          text = await runtime.memo('speech', text, ctx)
        }
        await write(
          host,
          input.voice as ConversationId,
          'voice.line',
          {
            role: 'ultimate',
            text,
            speech: true,
            source: { conversation: main, entry: settled.answer },
            ...(input.delegation ? { delegation: input.delegation } : {}),
          },
          `voice:answer:${line}`,
        )
        const response = await runtime.memo<ResponseReceipt>('response', ctx)
        await runtime.commit(async (tx) => {
          await summaries.accountResponse(tx, input.voice as ConversationId, response)
          return terminal
        }, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}

export const actions = {
  status: implementAction(StatusAction, async (_args, { host, signal }) =>
    (await apiKey(host, signal))
      ? { available: true as const }
      : { available: false as const, reason: NO_KEY },
  ),
  start: implementAction(StartAction, async (args, { host, signal }) => {
    const sdp = args && typeof args === 'object' && !Array.isArray(args) ? args.sdp : undefined
    if (typeof sdp !== 'string' || !sdp.trim()) throw new Error('Expected an SDP offer')
    const key = await apiKey(host, signal)
    if (!key) throw new Error(NO_KEY)
    const id = await host.harness().commit(async (tx) => {
      const state = await tx.doc(Voice, ROOT_CONVERSATION_ID)
      if (state.conversation) return state.conversation as ConversationId
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      Object.assign(await tx.doc(host.metadata, conversation.id), {
        title: 'Voice',
        label: 'voice',
      })
      await host.need(ConversationsApi).setAutomaticSummaries(tx, conversation.id, false)
      state.conversation = conversation.id
      return conversation.id
    }, context)
    const recent = await host.harness().commit((tx) => lines(tx, id, 10), context)
    // Bound both messages and input size, leaving room below the 8,192-token session seed cap.
    const input = recent.map((line) => ({
      type: 'message',
      role: line.role === 'daniel' ? 'user' : 'assistant',
      content: [
        {
          type: line.role === 'daniel' ? 'input_text' : 'output_text',
          text: line.text.slice(0, 200),
        },
      ],
    }))
    const response = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: 'gpt-live-1',
          instructions: LIVE_INSTRUCTIONS,
          audio: { output: { voice: 'marin' } },
          delegation: { type: 'client' },
          ...(input.length ? { input } : {}),
        },
        transport: { type: 'webrtc', sdp },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) throw new Error(`OpenAI live session failed (HTTP ${response.status})`)
    const answer = (await response.json()) as {
      session?: { id?: string }
      transport?: { type?: string; sdp?: string }
    }
    if (!answer.session?.id || answer.transport?.type !== 'webrtc' || !answer.transport.sdp)
      throw new Error('OpenAI returned no WebRTC session answer')
    await write(
      host,
      id,
      'voice.session',
      { phase: 'started', at: Date.now() },
      `voice:start:${answer.session.id}`,
    )
    return { sdp: answer.transport.sdp, conversation: id }
  }),
  say: implementAction(SayAction, async (args, { host }) => {
    const { text: raw, delegation } =
      args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (
      typeof raw !== 'string' ||
      !raw.trim() ||
      (delegation !== undefined && typeof delegation !== 'string')
    )
      throw new Error('Expected text and an optional delegation id')
    const text = raw.trim()
    const id = await voiceId(host)
    const main = (await host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
    if (!main) throw new Error('@ultimate is not available')
    // The task exists before the line: a crash after this commit still writes and relays it.
    const input = {
      voice: id,
      main,
      request: crypto.randomUUID(),
      text,
      ...(delegation ? { delegation } : {}),
    }
    await host.harness().commit(async (tx) => {
      const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
      await tx.createTask(
        answerTask(host),
        { ...input, firstMessage: log.next },
        { conversationId: id, ownership: { kind: 'conversation' }, background: true },
      )
    }, context)
    host.harness().resume()
    const line = await write(
      host,
      id,
      'voice.line',
      danielLine(input),
      `voice:line:${input.request}`,
    )
    return { line }
  }),
  end: implementAction(EndAction, async (args, { host }) => {
    const seconds =
      args && typeof args === 'object' && !Array.isArray(args) ? args.seconds : undefined
    if (
      seconds !== undefined &&
      (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
    )
      throw new Error('Expected nonnegative seconds')
    await write(
      host,
      await voiceId(host),
      'voice.session',
      {
        phase: 'ended',
        at: Date.now(),
        ...(seconds !== undefined ? { seconds } : {}),
      },
      `voice:end:${crypto.randomUUID()}`,
    )
    return {}
  }),
}

export default (host: ExtensionHost) => {
  host.need(MessagesApi)
  return defineExtension({ name: 'voice-live', tasks: [answerTask(host)] })
}
