import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import { createHash } from 'node:crypto'
import { AgentDoc, defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
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
import type { SessionRecord } from './sessions.ts'
import { sdkRunner } from './runner.ts'
import type { Runner, RunnerEvent } from './runner.ts'
import { ToolBridge, bridgeTools } from './bridge.ts'
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
  contextWindow: 0,
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

interface LiveQuery {
  run: ReturnType<Runner>
  bridge: ToolBridge
  iterator: AsyncIterator<RunnerEvent>
  next?: Promise<IteratorResult<RunnerEvent>>
  call?: ReturnType<ToolBridge['next']>
  locks: ReturnType<typeof exclusiveHooks>
  controller: AbortController
  stopping?: Promise<void>
  watching?: boolean
}
function stop(state: LiveQuery) {
  state.stopping ??= (async () => {
    void state.run.interrupt().catch(() => {})
    await setTimeout(3000)
    state.run.kill()
    state.controller.abort()
    state.locks.close()
  })()
  return state.stopping
}

export function createClaudeProvider(
  host: ExtensionHost,
  sessions: Sessions,
  runner: Runner,
): Provider {
  const live = new Map<string, LiveQuery>()
  const retire = (id: string) => {
    const record = sessions.get(id)
    if (!record) return
    record.handled = [...new Set([...record.handled, ...(record.turn?.keys ?? [])])]
    delete record.turn
    delete record.bridge
    delete record.pid
    sessions.put(record)
  }
  host.onClose?.(async () => {
    const states = [...live.values()]
    live.clear()
    await Promise.all(states.map(stop))
  })
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
      let held = false
      let sessionId: string | undefined
      let stateRef: LiveQuery | undefined
      let received = false
      let hadSuccess = false
      const signal = options?.signal ?? new AbortController().signal
      const abort = () => {
        if (sessionId) retire(sessionId)
        if (stateRef) void stop(stateRef)
      }
      try {
        if (!options?.sessionId)
          throw new Error('Claude Code requires a durable conversation sessionId')
        const id = options.sessionId
        sessionId = id
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
          conversationId?: number
          aborted?: string[]
          explicitTools?: string[]
        }
        const previous = sessions.get(id)
        const fresh = userTurns(context).filter((turn) => !previous?.handled.includes(turn.key))
        hadSuccess = !!previous?.result
        let record: SessionRecord = previous ?? { id, cwd: target.cwd, handled: [] }
        if (!fresh.length && !record.turn && record.result) {
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
        let state = live.get(id)
        if (state?.stopping) {
          await state.stopping
          if (live.get(id) === state) live.delete(id)
          record = sessions.get(id) ?? record
          state = undefined
        }
        const canceled = record.bridge?.some((call) => target.aborted?.includes(call.id))
        if (canceled) {
          if (state) {
            await stop(state)
            live.delete(id)
            state = undefined
          }
          retire(id)
          record = sessions.get(id)!
        }
        const recovering = !!record.turn
        const unhandled = userTurns(context).filter(
          (turn) => !record.handled.includes(turn.key) && !record.turn?.keys.includes(turn.key),
        )
        if (state?.bridge.lost) {
          await stop(state)
          live.delete(id)
          state = undefined
        }
        if (state && unhandled.length && recovering) {
          await stop(state)
          live.delete(id)
          state = undefined
        }
        const results = context.messages.filter((item) => item.role === 'toolResult')
        const missing =
          record.bridge?.filter(
            (call) => !results.some((result) => result.toolCallId === call.id),
          ) ?? []
        if (missing.length) {
          message.content = missing.map((call) => ({ type: 'toolCall', ...call }))
          message.stopReason = 'toolUse'
          events.push({ type: 'done', reason: 'toolUse', message })
          events.end(message)
          held = !!state
          return
        }
        if (state) for (const result of results) state.bridge.resolve(result)
        if (!state && record.pid) {
          const warning = killOrphan(record.pid, id)
          if (warning) host.notice(warning)
          delete record.pid
        }
        const recoveredResults = results.filter((result) =>
          record.bridge?.some((call) => call.id === result.toolCallId),
        )
        const prompt = recovering
          ? recoveredResults.length
            ? recoveredResults
                .map(
                  (result) =>
                    `Your call to ${result.toolName} was interrupted by a restart; its result was: ${JSON.stringify({ content: result.content, isError: result.isError })}; continue without repeating the call.`,
                )
                .join('\n')
            : continuePrompt
          : unhandled.map((turn) => turn.text).join('\n\n')
        const input =
          recovering && unhandled.length
            ? prompt + '\n\nNew input:\n' + unhandled.map((turn) => turn.text).join('\n\n')
            : prompt
        if (!input) throw new Error('Claude Code has no new user input')
        record.turn ??= { keys: [], prompt: input }
        record.turn.keys = [...new Set([...record.turn.keys, ...unhandled.map((turn) => turn.key)])]
        sessions.put(record)
        if (!state) {
          const controller = new AbortController()
          locks = exclusiveHooks(host, controller.signal)
          const bridge = new ToolBridge(bridgeTools(context, target.explicitTools), ['screenshot'])
          signal.throwIfAborted()
          run = runner({
            prompt: input,
            id,
            resume: !!previous,
            model: model.id,
            cwd: target.cwd,
            append: await promptAppend(target.cwd, target.instructions, target.conversation),
            plugin: await pluginDirectory(host, target.cwd, id),
            store: sessions.mirror,
            signal: controller.signal,
            hooks: {
              ...locks.hooks,
              PreToolUse: [...(locks.hooks.PreToolUse ?? []), ...(bridge.hooks.PreToolUse ?? [])],
              PostToolUse: [
                ...(locks.hooks.PostToolUse ?? []),
                ...(bridge.hooks.PostToolUse ?? []),
              ],
              PostToolUseFailure: [
                ...(locks.hooks.PostToolUseFailure ?? []),
                ...(bridge.hooks.PostToolUseFailure ?? []),
              ],
            },
            mcpServers: { ultimate: bridge.server },
            onPid(pid) {
              record.pid = pid
              sessions.put(record)
            },
          })
          state = { run, bridge, iterator: run[Symbol.asyncIterator](), locks, controller }
          live.set(id, state)
        }
        stateRef = state
        run = state.run
        locks = state.locks
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        events.push({ type: 'start', partial: message })
        const thinking = { type: 'thinking' as const, thinking: '' }
        message.content.push(thinking)
        events.push({ type: 'thinking_start', contentIndex: 0, partial: message })
        let complete = false
        while (true) {
          state.next ??= state.iterator.next().then(
            (value) => {
              if (
                state.bridge.pending.size &&
                (value.done || value.value.type === 'result' || value.value.type === 'error')
              )
                state.bridge.lost = true
              return value
            },
            (error: unknown) => {
              state.bridge.lost = true
              return { done: false, value: { type: 'error' as const, message: String(error) } }
            },
          )
          state.call ??= state.bridge.next()
          const item = await Promise.race([
            state.next.then((value) => ({ type: 'event' as const, value })),
            state.call.then((value) => ({ type: 'call' as const, value })),
          ])
          signal.throwIfAborted()
          if (item.type === 'call') {
            state.call = undefined
            const call = item.value
            record.bridge ??= []
            record.bridge.push(call)
            sessions.put(record)
            events.push({
              type: 'thinking_end',
              contentIndex: 0,
              content: thinking.thinking,
              partial: message,
            })
            const toolCall = { type: 'toolCall' as const, ...call }
            message.content.push(toolCall)
            events.push({ type: 'toolcall_start', contentIndex: 1, partial: message })
            events.push({ type: 'toolcall_end', contentIndex: 1, toolCall, partial: message })
            message.stopReason = 'toolUse'
            events.push({ type: 'done', reason: 'toolUse', message })
            events.end(message)
            held = true
            if (!state.watching && target.conversationId !== undefined) {
              state.watching = true
              const retained = state
              void (async () => {
                const conversation = await host
                  .harness()
                  .conversation(target.conversationId as ConversationId, BACKGROUND_CONTEXT)
                await conversation!.waitForIdle(BACKGROUND_CONTEXT)
                if (live.get(id) !== retained) return
                retire(id)
                await stop(retained)
                if (live.get(id) === retained) live.delete(id)
              })().catch((error: unknown) =>
                host.notice(`Claude Code run observation failed: ${String(error)}`),
              )
            }
            return
          }
          state.next = undefined
          if (item.value.done) break
          const event = item.value.value
          received = true
          if (event.type === 'boundary') state.bridge.prune(event.ids)
          if (event.type === 'tool') {
            const delta = `${event.name}: ${JSON.stringify(event.input)}\n`
            thinking.thinking += delta
            events.push({ type: 'thinking_delta', contentIndex: 0, delta, partial: message })
          }
          if (event.type === 'error') throw new Error(event.message)
          if (event.type === 'result') {
            state.bridge.prune()
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
        delete record.bridge
        delete record.pid
        sessions.put(record)
        events.push({ type: 'done', reason: 'stop', message })
        events.end(message)
      } catch (error) {
        message.stopReason = signal.aborted ? 'aborted' : 'error'
        if (sessionId) {
          if (signal.aborted) retire(sessionId)
          else if (!received && !hadSuccess) sessions.delete(sessionId)
        }
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
        if (!held) {
          if (stateRef?.stopping) await stateRef.stopping
          else {
            run?.kill()
            stateRef?.controller.abort()
            locks?.close()
          }
          if (sessionId && live.get(sessionId) === stateRef) live.delete(sessionId)
        }
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
          const configured = await host.harness().snapshot(AgentDoc, api.conversationId, context)
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
                    conversationId: api.conversationId,
                    explicitTools: Array.isArray(configured?.tools) ? configured.tools : [],
                    aborted: (await conversation!.context(context)).entries
                      .filter(
                        (entry) =>
                          entry.kind === 'pi.tool-result' &&
                          (
                            entry.data as { diagnostics?: { code?: string }[] } | undefined
                          )?.diagnostics?.some((diagnostic) => diagnostic.code === 'aborted'),
                      )
                      .flatMap(
                        (entry) =>
                          entry.model?.flatMap((message) =>
                            message.role === 'toolResult' ? [message.toolCallId] : [],
                          ) ?? [],
                      ),
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
