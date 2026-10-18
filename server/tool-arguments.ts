import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessageEventStream, Models } from '@earendil-works/pi-ai'

/**
 * Whitespace characters in a row past which a tool call's arguments count as degenerate. JSON never needs that much,
 * and inside a string a file's newlines arrive escaped, so even a large `write` stays far below it.
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
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const controller = new AbortController()
  const source = open(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
  const guarded = createAssistantMessageEventStream()
  const runs = new Map<number, number>()
  void (async () => {
    for await (const event of source) {
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
          const error = {
            ...event.partial,
            content: [...event.partial.content],
            stopReason: 'error' as const,
            errorMessage,
          }
          guarded.push({ type: 'error', reason: 'error', error })
          return
        }
      }
      guarded.push(event)
    }
  })()
  return guarded
}
