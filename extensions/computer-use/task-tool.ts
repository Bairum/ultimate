import { Type } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import { defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ClassifyApi } from '../classify/api.ts'
import type { Verdict } from './types.ts'
import { readSession, updateSession } from './session.ts'
import { result, anchored, plainTask, activatePending, object } from './tool-helpers.ts'
import { runtime, setup, cacheKey } from './runtime.ts'
import { predicates } from './schemas.ts'

import * as task from './task.ts'

export type TaskArgs =
  | { action: 'start'; spec: Parameters<typeof task.startTask>[0] }
  | { action: 'subgoals'; list: { id: string; text: string }[] }
  | { action: 'activate'; id: string }
  | { action: 'complete'; subgoal: string }
  | { action: 'checkpoint'; assessment: string; recentSteps: string[] }
  | ({ action: 'replan' } & task.Replan)
  | { action: 'finish'; outcome: 'done' | 'partial' | 'blocked'; summary: string }
  | { action: 'status' }
export const subgoalsSchema = Type.Array(Type.Object({ id: Type.String(), text: Type.String() }), {
  minItems: 1,
})
export const criteriaSchema = Type.Array(
  Type.Object({
    id: Type.String(),
    text: Type.String(),
    check: Type.Union([Type.Literal('evidence'), predicates]),
  }),
)
export const scopeSchema = Type.Object({
  apps: Type.Array(Type.String()),
  params: Type.Record(Type.String(), Type.String()),
  actions: Type.Array(Type.String()),
  consequential: Type.Array(Type.String()),
})
export async function taskTool(
  host: ExtensionHost,
  conversation: number,
  call: string,
  args: TaskArgs,
  signal: AbortSignal,
) {
  const planned =
    args.action === 'subgoals' ? args.list : args.action === 'replan' ? args.subgoals : undefined
  if (planned && !planned.length)
    return anchored(
      host,
      conversation,
      result({ status: 'invalid_arguments', message: 'Subgoals must not be empty' }),
    )
  if (args.action === 'start') {
    signal.throwIfAborted()
    if (!(await intentInConversation(host, conversation, args.spec.intent)))
      return anchored(
        host,
        conversation,
        result({
          status: 'intent_required',
          message:
            'intent must equal a whole message, sentence or line from this conversation’s user input or operator brief.',
        }),
      )
    signal.throwIfAborted()
    const started = task.startTask(args.spec, Date.now())
    started.state = task.activate(
      task.setSubgoals(started.state, [{ id: 'S1', text: started.state.spec.goal }], Date.now()),
      'S1',
      Date.now(),
    )
    await updateSession(host, conversation, (doc) => {
      if (
        doc.task &&
        ['active', 'awaiting_confirmation', 'stopped', 'paused_by_user'].includes(doc.task.status)
      )
        throw new Error('Finish the current task before starting another')
      doc.task = started.state
      doc.confirmed = []
      doc.budget = { steps: 0, startedAt: 0 }
      doc.pending = doc.pending.filter((p) => p.kind === 'consent')
      if (started.needsConfirmation.length)
        doc.pending.push({
          kind: 'task',
          app: started.state.spec.scope.apps.join(', '),
          at: Date.now(),
        })
    })
    return anchored(
      host,
      conversation,
      result({ status: started.state.status, needsConfirmation: started.needsConfirmation }),
    )
  }
  if (args.action === 'complete') {
    let refusal: task.Refusal | undefined
    await updateSession(host, conversation, (doc) => {
      if (!doc.task) {
        refusal = { refuse: 'no_task', message: 'No task' }
        return
      }
      refusal = task.requireActiveTask(doc.task)
      if (refusal) return
      const next = task.completeSubgoal(plainTask(doc.task), args.subgoal, Date.now())
      if ('refuse' in next) refusal = next
      else doc.task = activatePending(next)
    })
    return anchored(
      host,
      conversation,
      result({ status: refusal?.refuse ?? 'completed', message: refusal?.message }),
    )
  }
  const state = (await readSession(host, conversation)).task
  if (!state) return anchored(host, conversation, result({ status: 'no_task' }))
  if (args.action === 'status')
    return anchored(host, conversation, result({ status: state.status, note: task.note(state) }))
  const refusal =
    args.action === 'finish' && args.outcome !== 'done' ? undefined : task.requireActiveTask(state)
  if (refusal)
    return anchored(
      host,
      conversation,
      result({ status: refusal.refuse, message: refusal.message }),
    )
  if (args.action === 'finish') {
    return setup(host, conversation, async (driver) => {
      const evidence: task.Evidence[] = []
      const finished = await task.finish(
        state,
        args.outcome,
        async (preds) => {
          let verdict: Verdict = 'unsatisfied'
          for (const app of state.spec.scope.apps) {
            const listed = await driver.call('list_windows', { app }, signal)
            const windows = listed.structured?.windows
            if (!listed.ok || !Array.isArray(windows) || !windows.length) verdict = 'unknown'
            for (const window of Array.isArray(windows) ? windows.map(object) : []) {
              const checked = await driver.call(
                'verify_state',
                { pid: window.pid!, window_id: window.window_id!, expect: preds, timeout_ms: 0 },
                signal,
              )
              const value = checked.structured?.verdict ?? checked.structured?.status
              if (checked.ok && value === 'satisfied') {
                evidence.push({
                  kind: 'verify',
                  predicates: preds,
                  verdict: 'satisfied',
                  ref: call,
                  app,
                })
                return 'satisfied'
              }
              if (!checked.ok || value !== 'unsatisfied') verdict = 'unknown'
            }
          }
          return verdict
        },
        host.want(ClassifyApi)
          ? (request, requestSignal) => host.want(ClassifyApi)!.ask(request, requestSignal)
          : undefined,
        signal,
        Date.now(),
      )
      const lastDone = finished.state.ledger.findLast(
        (entry) => entry.kind === 'subgoal_done',
      )?.reason
      const active =
        finished.state.subgoals.find((s) => s.status === 'active') ??
        finished.state.subgoals.find((s) => s.status === 'done' && s.id === lastDone)
      if (active)
        for (const item of evidence)
          finished.state = task.addEvidence(finished.state, active.id, item)
      await updateSession(host, conversation, (doc) => {
        doc.confirmed = []
        doc.pending = doc.pending.filter((p) => p.kind !== 'confirm')
        // Stop can arrive during verification; completion must never overwrite it.
        if (doc.task?.status === state.status) doc.task = finished.state
        else if (doc.task) finished.state = plainTask(doc.task)
      })
      return result({
        status: finished.refuse ?? finished.state.status,
        criteria: finished.criteria,
        summary: args.summary,
      })
    })
  }
  let next = state
  let scores: unknown
  if (args.action === 'checkpoint') {
    const observation = runtime(host).observations.get(
      cacheKey(conversation, state.spec.scope.apps[0]),
    )
    const checked = await task.checkpoint(
      state,
      {
        assessment: args.assessment,
        recentSteps: args.recentSteps,
        app: observation?.app,
        window: observation?.title,
      },
      host.want(ClassifyApi)
        ? (request, requestSignal) => host.want(ClassifyApi)!.ask(request, requestSignal)
        : undefined,
      signal,
      Date.now(),
    )
    next = checked.state
    scores = checked.scores
  }
  await updateSession(host, conversation, (doc) => {
    if (!doc.task) throw new Error('No computer task')
    if (doc.task.status !== 'active') {
      next = plainTask(doc.task)
      return
    }
    if (args.action === 'subgoals')
      next = task.setSubgoals(plainTask(doc.task), args.list, Date.now())
    if (args.action === 'activate') next = task.activate(plainTask(doc.task), args.id, Date.now())
    if (args.action === 'replan') next = task.replan(plainTask(doc.task), args, Date.now())
    next = activatePending(next)
    doc.task = next
    if (next.pendingChange && !doc.pending.some((p) => p.kind === 'change'))
      doc.pending.push({ kind: 'change', app: next.spec.scope.apps.join(', '), at: Date.now() })
  })
  return anchored(
    host,
    conversation,
    result({ status: next.replanRequired ? 'replan_required' : next.status, scores }),
  )
}

export function taskToolDefinition(host: ExtensionHost) {
  return defineTool({
    name: 'computer_task',
    description:
      "Anchor desktop work to the user's verbatim intent, plan one subgoal, checkpoint, explicitly replan, and verify completion. Confirmations are user-only.",
    structuredOutputSchema: Type.Any(),
    parameters: Type.Unsafe<TaskArgs>(
      Type.Union([
        Type.Object({
          action: Type.Literal('start'),
          spec: Type.Object({
            id: Type.String(),
            intent: Type.String(),
            goal: Type.String(),
            criteria: criteriaSchema,
            scope: scopeSchema,
            stop: Type.Optional(
              Type.Object({
                steps: Type.Optional(Type.Number()),
                minutes: Type.Optional(Type.Number()),
                escalations: Type.Optional(Type.Number()),
              }),
            ),
            link: Type.Optional(
              Type.Object({ conversation: Type.Number(), task: Type.Optional(Type.String()) }),
            ),
          }),
        }),
        Type.Object({ action: Type.Literal('subgoals'), list: subgoalsSchema }),
        Type.Object({ action: Type.Literal('activate'), id: Type.String() }),
        Type.Object({ action: Type.Literal('complete'), subgoal: Type.String() }),
        Type.Object({
          action: Type.Literal('checkpoint'),
          assessment: Type.String(),
          recentSteps: Type.Array(Type.String()),
        }),
        Type.Object({
          action: Type.Literal('replan'),
          reason: Type.String(),
          subgoals: Type.Optional(subgoalsSchema),
          criteria: Type.Optional(criteriaSchema),
          scope: Type.Optional(scopeSchema),
        }),
        Type.Object({
          action: Type.Literal('finish'),
          outcome: Type.Union(['done', 'partial', 'blocked'].map((s) => Type.Literal(s))),
          summary: Type.String(),
        }),
        Type.Object({ action: Type.Literal('status') }),
      ]),
    ),
    async execute(args, api, ctx) {
      const state = runtime(host)
      if (state.busy) return anchored(host, api.conversationId, result({ status: 'busy' }))
      state.busy = true
      try {
        return await taskTool(
          host,
          api.conversationId,
          api.callId,
          args,
          ctx.abortSignal ?? new AbortController().signal,
        )
      } finally {
        state.busy = false
      }
    },
  })
}

export async function intentInConversation(
  host: ExtensionHost,
  conversation: number,
  intent: string,
) {
  const target = await host.harness().conversation(conversation as ConversationId, context)
  if (!target || !intent.trim()) return false
  const normalized = (text: string) => text.replace(/\s+/g, ' ').trim()
  let cursor: Parameters<typeof target.entries>[2]
  do {
    const page = await target.entries({}, 64, cursor, context)
    for (const entry of page.items) {
      // The subagents reporter submits its task brief as subagents.instruction, not pi.user.
      if (entry.kind !== 'pi.user' && entry.kind !== 'subagents.instruction') continue
      for (const message of entry.model ?? []) {
        if (message.role !== 'user') continue
        const text =
          typeof message.content === 'string'
            ? message.content
            : message.content
                .flatMap((block) => (block.type === 'text' ? [block.text] : []))
                .join(' ')
        const whole = normalized(text)
        const candidates = [
          whole,
          ...text.split(/\r?\n/).map(normalized),
          ...whole.split(/(?<=[.!?])\s+/),
        ]
        if (candidates.includes(normalized(intent))) return true
      }
    }
    cursor = page.next
  } while (cursor !== undefined)
  return false
}
