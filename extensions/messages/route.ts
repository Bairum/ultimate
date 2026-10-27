/** `board.route`: a branch's final answers reach the conversation that started it. */
import { defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  GenerationResult,
  SubmissionId,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Subagents } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { Messages } from './api.ts'
import { terminal } from './log.ts'
import { send } from './send.ts'

/**
 * Whether branch `id` still has work under way that will wake it again: a run or queued input, a subagent running or
 * its report on the way, a submission in the lander's queue, or a reply-enabled message still waiting on its answer.
 */
async function underway(host: ExtensionHost, tx: Tx, id: ConversationId): Promise<boolean> {
  if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.length) return true
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  if (
    log.messages.some(
      (m) => m.from === id && m.reply && (m.state === 'sent' || m.state === 'delivered'),
    )
  )
    return true
  const queue = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).queue
  if (queue.some((item) => item.conversationId === id)) return true
  return children(tx, id)
}
/** Whether a subagent of `id` (at any depth) runs or has input queued, or its report is still on the way. */
async function children(tx: Tx, id: ConversationId): Promise<boolean> {
  const state = await tx.doc(Subagents, id)
  if (Object.values(state.actions).some((action) => action.status === undefined)) return true
  for (const child of Object.values(state.agents)) {
    const childId = child.conversationId
    if ((await tx.doc(LiveDoc, childId)).run || (await tx.doc(InboxDoc, childId)).items.length)
      return true
    if (await children(tx, childId)) return true
  }
  return false
}

/**
 * After a branch's run, its final answer reaches the conversation that started it, unless it already does as the
 * answer to the starter's reply-enabled message. A branch that stops with nothing under way reports: its answer wakes
 * the starter. One that still waits on work (subagents, the lander, a reply) leaves it as a note. Routing goes only
 * from a branch to its starter, which existed first, and a routed message is one-way: it cannot ping-pong.
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
        const routed = await host.harness().commit(async (tx) => {
          // A continued generation's answer is no run's final answer: only inputs it settled make one.
          const answered = inputs.flatMap((input) =>
            input?.type === 'input' && input.status === 'done' && input.answer === answer
              ? [input.entry]
              : [],
          )
          if (!answered.length) return undefined
          for (const entryId of answered) {
            const entry = await tx.entry(entryId)
            // board.delivery returns the answer to the starter's reply-enabled message.
            const data = entry?.data as { from?: unknown; reply?: unknown } | undefined
            if (entry?.kind === 'board.message' && data?.from === by && data.reply === true)
              return undefined
          }
          const message = (await tx.entry(answer))?.model?.[0]
          if (
            message?.role !== 'assistant' ||
            message.stopReason === 'error' ||
            message.stopReason === 'aborted'
          )
            return undefined
          const text = message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
          return { text, report: !(await underway(host, tx, id)) }
        }, ctx)
        if (routed?.text.trim())
          await send(host, id, { to: `#${by}`, text: routed.text, reply: false }, ctx, {
            requestId: `route:${answer}`,
            note: !routed.report,
            report: routed.report,
          })
        await runtime.commit(() => terminal, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
