/** `board.route`: a branch's final answers reach the conversation that started it. */
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { GenerationResult, SubmissionId, TaskId } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Messages } from './api.ts'
import { needsDecision } from './triage.ts'
import { terminal } from './log.ts'
import { send } from './send.ts'

/**
 * After a branch's run, its final answer reaches the conversation that started it, unless that answer already does:
 * as the answer to the starter's reply-enabled message, or because the run messaged the starter itself. Routing only
 * goes from a branch to its starter, which existed first, and a routed message is one-way: it cannot ping-pong.
 */
export function route(host: ExtensionHost) {
  return defineTask<
    {
      generation: TaskId<GenerationResult>
      inputs: SubmissionId[]
      by: number
    },
    { phase: 'observe' },
    null
  >({
    name: 'board.route',
    version: 1,
    initial: () => ({ phase: 'observe' }),
    phases: {
      observe: async (task, runtime, ctx) => {
        const settled = await runtime.waitForTask(task.input.generation, ctx)
        if (settled.state.outcome.status !== 'completed') {
          await runtime.commit(() => terminal, ctx)
          return
        }
        const answer = settled.state.outcome.result.entryId
        const inputs = await Promise.all(
          task.input.inputs.map(async (id) =>
            (await host.harness().submission(id, ctx))?.status(ctx),
          ),
        )
        const { by } = task.input
        const id = runtime.conversationId
        const text = await host.harness().commit(async (tx) => {
          // A continued generation's answer is no run's final answer: only inputs it settled make one.
          const answered = inputs.flatMap((input) =>
            input?.type === 'input' && input.status === 'done' && input.answer === answer
              ? [input.entry]
              : [],
          )
          let since = Number.POSITIVE_INFINITY
          let replies = 0
          for (const entryId of answered) {
            const entry = await tx.entry(entryId)
            // board.delivery returns the answer to the starter's reply-enabled message; a one-way one gets none.
            const data = entry?.data as { from?: unknown; reply?: unknown } | undefined
            if (entry?.kind === 'board.message' && data?.from === by && data.reply === true)
              return undefined
            if (entry?.kind === 'board.reply' && data?.from === by) replies++
            since = Math.min(since, entry?.model?.[0]?.timestamp ?? since)
          }
          // A run woken only by the starter's own replies reacts to what the starter already knows.
          if (!answered.length || replies === answered.length) return undefined
          const message = (await tx.entry(answer))?.model?.[0]
          if (
            message?.role !== 'assistant' ||
            message.stopReason === 'error' ||
            message.stopReason === 'aborted'
          )
            return undefined
          const until = message.timestamp
          // Only tool calls count: an earlier run's routed answer can land after this run's input.
          const messaged = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.some(
            (m) =>
              m.from === id &&
              m.to === by &&
              m.call !== undefined &&
              m.at >= since &&
              m.at <= until,
          )
          if (messaged) return undefined
          return message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
        }, ctx)
        if (text?.trim())
          await send(
            host,
            id,
            { to: `#${by}`, text, reply: false },
            ctx,
            undefined,
            undefined,
            `route:${answer}`,
            undefined,
            !needsDecision(text),
          )
        await runtime.commit(() => terminal, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
