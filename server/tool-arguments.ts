import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Models,
} from '@earendil-works/pi-ai'

/**
 * Whitespace characters in a row past which a tool call's arguments count as degenerate. JSON never needs that much,
 * and inside a string a file's newlines arrive escaped, so even a large `write` stays far below it. Runs inside strings
 * count too: the degenerate streams seen so far pad an unterminated string, so only a line of over 1000 spaces in a
 * legitimate value would trip it.
 */
export const MAX_WHITESPACE_RUN = 1000

/**
 * `models` whose `streamSimple` ends a response with an error as soon as a tool call's arguments degenerate, instead of
 * streaming whitespace until the request times out. The error is retryable, so the generation's retry policy decides.
 */
export function guardToolArguments<T extends Models>(models: T): T {
  const streamSimple: Models['streamSimple'] = (model, context, options) =>
    guardStream(
      (signal) => models.streamSimple(model, context, { ...options, signal }),
      model,
      options?.signal,
    )
  return new Proxy(models, {
    get(target, key) {
      if (key === 'streamSimple') return streamSimple
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** The stream `open` returns, ended with an error and aborted once a tool call's arguments degenerate. */
export function guardStream(
  open: (signal: AbortSignal) => AssistantMessageEventStream,
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const controller = new AbortController()
  const source = open(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
  const guarded = createAssistantMessageEventStream()
  const runs = new Map<number, number>()
  let partial: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    timestamp: Date.now(),
  }
  const fail = (errorMessage: string) => {
    const error = { ...partial, content: [...partial.content], stopReason: 'error' as const }
    guarded.push({ type: 'error', reason: 'error', error: { ...error, errorMessage } })
  }
  void (async () => {
    for await (const event of source) {
      if ('partial' in event) partial = event.partial
      if (event.type === 'toolcall_delta') {
        let run = runs.get(event.contentIndex) ?? 0
        for (const char of event.delta) {
          run = /\s/.test(char) ? run + 1 : 0
          if (run > MAX_WHITESPACE_RUN) break
        }
        runs.set(event.contentIndex, run)
        if (run > MAX_WHITESPACE_RUN) {
          controller.abort()
          const call = event.partial.content[event.contentIndex]
          const name = call?.type === 'toolCall' ? `${call.name} ` : ''
          // Pi's retry classification matches "you can retry your request"; a new sample rarely degenerates again.
          // Pi upstream: @earendil-works/pi-ai@1.3.0 src/utils/retry.ts — RETRYABLE_PROVIDER_ERROR_PATTERN decides which errors a generation retries. Drop when Pi Durable lets a stream mark its error retryable.
          const errorMessage = `Aborted degenerate tool-call arguments: ${name}arguments contain more than ${MAX_WHITESPACE_RUN} whitespace characters in a row; you can retry your request`
          fail(errorMessage)
          return
        }
      }
      guarded.push(event)
      if (event.type === 'done' || event.type === 'error') return guarded.end()
    }
    // A source may also settle by its result alone, without a terminal event.
    guarded.end(await source.result())
  })().catch((error: unknown) => {
    fail(`Model stream failed: ${String(error)}`)
    guarded.end()
  })
  return guarded
}
