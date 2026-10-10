import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import type {
  AssistantMessage,
  Model,
  StreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Sessions, killOrphan } from './sessions.ts'
import { sdkRunner } from './runner.ts'
import type { Runner } from './runner.ts'
import { exclusiveHooks, pluginDirectory, promptAppend } from './setup.ts'

const aliases = ['opus', 'sonnet', 'haiku', 'fable']
const models: Model<string>[] = aliases.map((id) => ({
  id,
  name: `Claude Code ${id}`,
  api: 'claude-code',
  provider: 'claude-code',
  baseUrl: '',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 32000,
}))
const marker = 'claude-code-context'
export const continuePrompt =
  'You were interrupted by an Ultimate restart. Continue the turn already in your session; do not repeat completed actions. Answer the original request.'

export function userTurns(context: TranscriptContext) {
  return context.messages.flatMap((message) => {
    if (message.role !== 'user') return []
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
    return [
      {
        text,
        key: createHash('sha256')
          .update(JSON.stringify([message.timestamp, text]))
          .digest('hex'),
      },
    ]
  })
}

export function createClaudeProvider(
  host: ExtensionHost,
  sessions: Sessions,
  runner: Runner,
): Provider {
  const stream = (model: Model<string>, context: TranscriptContext, options?: StreamOptions) => {
    const events = createAssistantMessageEventStream()
    const message: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      timestamp: Date.now(),
      stopReason: 'stop',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    void (async () => {
      let run: ReturnType<Runner> | undefined
      let locks: ReturnType<typeof exclusiveHooks> | undefined
      const signal = options?.signal ?? new AbortController().signal
      const abort = () => {
        void run?.interrupt().catch(() => {})
        run?.kill()
      }
      try {
        if (!options?.sessionId)
          throw new Error('Claude Code requires a durable conversation sessionId')
        const id = options.sessionId
        const metadata = context.messages.findLast(
          (item) => item.role === 'system' && item.sections?.[marker],
        )
        if (metadata?.role !== 'system')
          throw new Error(
            'Claude Code conversation context missing; enable the claude-code extension for this child',
          )
        const target = JSON.parse(metadata.sections![marker]!) as {
          cwd: string
          instructions: string
          conversation: number
        }
        const previous = sessions.get(id)
        const fresh = userTurns(context).filter((turn) => !previous?.handled.includes(turn.key))
        const recovering = !!previous?.turn
        const record = previous ?? { id, cwd: target.cwd, handled: [] }
        if (!fresh.length && !recovering && record.result) {
          const result = record.result
          message.content = [{ type: 'text', text: result.text }]
          message.usage = {
            ...message.usage,
            ...result.usage,
            totalTokens:
              result.usage.input +
              result.usage.output +
              result.usage.cacheRead +
              result.usage.cacheWrite,
            cost: { ...message.usage.cost, total: result.usage.cost },
          }
          events.push({ type: 'done', reason: 'stop', message })
          events.end(message)
          return
        }
        if (record.pid) {
          killOrphan(record.pid)
          delete record.pid
        }
        const prompt = recovering ? continuePrompt : fresh.map((turn) => turn.text).join('\n\n')
        if (!prompt) throw new Error('Claude Code has no new user input')
        record.turn ??= { keys: fresh.map((turn) => turn.key), prompt }
        sessions.put(record)
        locks = exclusiveHooks(host, signal)
        signal.throwIfAborted()
        run = runner({
          prompt,
          id,
          resume: !!previous,
          model: model.id,
          cwd: target.cwd,
          append: await promptAppend(target.cwd, target.instructions, target.conversation),
          plugin: await pluginDirectory(host, target.cwd, id),
          store: sessions.mirror,
          signal,
          hooks: locks.hooks,
          onPid(pid) {
            record.pid = pid
            sessions.put(record)
          },
        })
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        events.push({ type: 'start', partial: message })
        const thinking = { type: 'thinking' as const, thinking: '' }
        message.content.push(thinking)
        events.push({ type: 'thinking_start', contentIndex: 0, partial: message })
        let complete = false
        for await (const event of run) {
          signal.throwIfAborted()
          if (event.type === 'tool' || event.type === 'text') {
            const delta =
              event.type === 'tool' ? `${event.name}: ${JSON.stringify(event.input)}\n` : event.text
            thinking.thinking += delta
            events.push({ type: 'thinking_delta', contentIndex: 0, delta, partial: message })
          }
          if (event.type === 'error') throw new Error(event.message)
          if (event.type === 'result') {
            events.push({
              type: 'thinking_end',
              contentIndex: 0,
              content: thinking.thinking,
              partial: message,
            })
            message.content.push({ type: 'text', text: event.text })
            events.push({ type: 'text_start', contentIndex: 1, partial: message })
            events.push({
              type: 'text_delta',
              contentIndex: 1,
              delta: event.text,
              partial: message,
            })
            events.push({
              type: 'text_end',
              contentIndex: 1,
              content: event.text,
              partial: message,
            })
            // SDK cost is cumulative across resumes; Pi accounts each generation separately.
            const usage = {
              ...event.usage,
              cost: Math.max(0, event.usage.cost - (record.totalCost ?? 0)),
            }
            record.totalCost = event.usage.cost
            message.usage = {
              ...message.usage,
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
              cost: { ...message.usage.cost, total: usage.cost },
            }
            record.result = { text: event.text, usage }
            complete = true
          }
        }
        if (!complete) throw new Error('Claude Code exited without a result')
        record.handled.push(...record.turn.keys)
        delete record.turn
        delete record.pid
        sessions.put(record)
        events.push({ type: 'done', reason: 'stop', message })
        events.end(message)
      } catch (error) {
        message.stopReason = signal.aborted ? 'aborted' : 'error'
        const text = String(error)
        message.errorMessage = /not logged|authentication|login|401/i.test(text)
          ? 'Claude Code is not logged in: run `claude` and `/login` in a terminal'
          : /ENOENT|binary missing/i.test(text)
            ? 'Claude Code binary missing: install Claude Code and run `claude` in a terminal'
            : text
        events.push({ type: 'error', reason: message.stopReason, error: message })
        events.end(message)
      } finally {
        signal.removeEventListener('abort', abort)
        run?.kill()
        locks?.close()
      }
    })()
    return events
  }
  return {
    id: 'claude-code',
    name: 'Claude Code',
    auth: { apiKey: { name: 'Claude Code own login', resolve: async () => ({ auth: {} }) } },
    getModels: () => models,
    stream,
    streamSimple: stream,
  }
}

/** Explicit injection seam: production defaults to the SDK; tests supply only a fake runner. */
export function claudeCode(host: ExtensionHost, runner: Runner = sdkRunner) {
  const sessions = host.resource('claude-code.sessions', () => {
    const store = new Sessions(join(host.home, 'claude-code.sqlite'))
    host.onClose(async () => store.close())
    return store
  })
  host.modelRuntime.registerNativeProvider(createClaudeProvider(host, sessions, runner))
  return defineExtension({
    name: 'claude-code',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const conversation = await host.harness().conversation(api.conversationId, context)
          const agent = await conversation!.agent(context)
          if (agent.model?.provider !== 'claude-code') return undefined
          const parent =
            host.conversations().find((item) => item.id === api.conversationId)
              ?.parentConversationId ?? api.conversationId
          return {
            messages: [
              ...messages,
              {
                role: 'system',
                content: '',
                timestamp: Date.now(),
                sections: {
                  [marker]: JSON.stringify({
                    cwd: agent.cwd ?? host.projectRoot,
                    instructions: agent.instructions ?? '',
                    conversation: parent,
                  }),
                },
              },
            ],
          }
        },
      }),
    ],
  })
}
export default claudeCode
