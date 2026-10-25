import { Type } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ConversationId } from '@earendil-works/pi-durable'
import { defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ClassifyApi } from '../classify/api.ts'
import type { Verdict } from './types.ts'
import { readSession, updateSession, isStopped } from './session.ts'
import { result, anchored, plainTask, activatePending, object } from './tool-helpers.ts'
import { runtime, setup, cacheKey, settings } from './runtime.ts'
import { predicates } from './schemas.ts'

import * as task from './task.ts'
import { pixelDefaults } from './perception.ts'
import { observeWindow } from './observe.ts'
import { verifyOcr, ocrEvidence } from './verify-ocr.ts'
import { allGrants, resolveIdentity, readConsent } from './gates.ts'
import { redactor } from './content.ts'
import { readTeach } from './teach.ts'

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
export const approvalSchema = Type.Object({
  app: Type.String(),
  appName: Type.Optional(Type.String()),
  window: Type.Optional(Type.Union([Type.String(), Type.Integer({ minimum: 1 })])),
  pixel: Type.Literal(true),
  actions: Type.Array(Type.String(), { minItems: 1 }),
  steps: Type.Integer({ minimum: 1, maximum: 200 }),
  minutes: Type.Number({ exclusiveMinimum: 0, maximum: 60 }),
  foreground: Type.Boolean(),
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
      const taught = (await readTeach(host, conversation)).practice
      const practice =
        taught?.task === state.spec.id && state.practiceRun === taught.task ? taught : undefined
      const practiceModule = practice ? await import('./practice.ts') : undefined
      const finished = await task.finish(
        state,
        args.outcome,
        async (preds) => {
          if (practice && practiceModule)
            return practiceModule.finalPracticeCheck(host, conversation, driver, practice, signal)
          let verdict: Verdict = 'unsatisfied'
          for (const app of state.spec.scope.apps) {
            const listed = await driver.call('list_windows', { app }, signal)
            const windows = listed.structured?.windows
            if (!listed.ok || !Array.isArray(windows) || !windows.length) verdict = 'unknown'
            for (const window of Array.isArray(windows) ? windows.map(object) : []) {
              if (preds.some((p) => p.ocr)) {
                if (await isStopped(host, conversation, { signal })) return 'unknown'
                const identity = await resolveIdentity(driver, app, signal)
                if (
                  !identity ||
                  readConsent(
                    identity,
                    await allGrants(host, conversation, await readSession(host, conversation)),
                  ) !== 'granted'
                ) {
                  verdict = 'unknown'
                  continue
                }
                const observed = await observeWindow(
                  driver,
                  app,
                  Number(window.window_id),
                  'always',
                  undefined,
                  1568,
                  signal,
                )
                const checked = await verifyOcr(
                  driver,
                  observed,
                  preds,
                  { ...pixelDefaults, ...(await settings(host)).pixel },
                  signal,
                  redactor(Object.values(state.spec.scope.params)),
                )
                if (checked.verdict === 'satisfied') {
                  evidence.push(
                    await ocrEvidence(
                      host.home,
                      conversation,
                      observed,
                      preds,
                      call,
                      checked.excerpt,
                    ),
                  )
                  return 'satisfied'
                }
                if (checked.verdict === 'unknown') verdict = 'unknown'
                continue
              }
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
        practice && practiceModule
          ? { criteria: practiceModule.practiceCriteria(practice.steps), checks: practice.checks }
          : undefined,
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
        if (doc.task?.status === state.status) {
          // Own input can revoke run authority without changing task status while verification awaits.
          if (!doc.task.runTakeover) finished.state.runTakeover = false
          if (doc.task.practiceMismatch) {
            finished.state.practiceMismatch = true
            finished.state.runTakeover = false
          }
          doc.task = finished.state
        } else if (doc.task) finished.state = plainTask(doc.task)
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
  const replanLesson =
    args.action === 'replan' && args.scope
      ? (await readTeach(host, conversation)).practice
      : undefined
  const validateLabels =
    args.action === 'replan' && args.scope
      ? (await import('./practice.ts')).taughtConsequential
      : undefined
  let rejectedLabels = false
  await updateSession(host, conversation, (doc) => {
    if (!doc.task) throw new Error('No computer task')
    if (doc.task.status !== 'active') {
      next = plainTask(doc.task)
      return
    }
    if (
      args.action === 'replan' &&
      args.scope &&
      doc.task.practiceRun === doc.task.spec.id &&
      (replanLesson?.task !== doc.task.spec.id ||
        !validateLabels?.(replanLesson.steps, args.scope.consequential))
    ) {
      rejectedLabels = true
      return
    }
    if (args.action === 'subgoals')
      next = task.setSubgoals(plainTask(doc.task), args.list, Date.now())
    if (args.action === 'activate') next = task.activate(plainTask(doc.task), args.id, Date.now())
    if (args.action === 'replan') next = task.replan(plainTask(doc.task), args, Date.now())
    next = activatePending(next)
    if (!doc.task.runTakeover) next.runTakeover = false
    doc.task = next
    if (next.pendingChange && !doc.pending.some((p) => p.kind === 'change'))
      doc.pending.push({ kind: 'change', app: next.spec.scope.apps.join(', '), at: Date.now() })
  })
  if (rejectedLabels)
    return anchored(host, conversation, result({ status: 'consequential_not_taught' }))
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
            approval: Type.Optional(approvalSchema),
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
          approval: Type.Optional(approvalSchema),
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

function parameterInText(text: string, value: string) {
  const explicit = [...text.split(/\r?\n/), ...text.split(/(?<=[.!?])\s+/)].map((part) =>
    part.trim(),
  )
  if (explicit.includes(value)) return true
  const quoted =
    /"([^"]*)"|(?<![\p{L}\p{N}_])'([^']*)'(?![\p{L}\p{N}_])|`([^`]*)`|“([^”]*)”|(?<![\p{L}\p{N}_])‘([^’]*)’(?![\p{L}\p{N}_])/gu
  if ([...text.matchAll(quoted)].some((match) => match.slice(1).includes(value))) return true
  if (
    Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.trim()))
      .length < 3
  )
    return false
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Keep identifiers, paths and contractions intact; trailing sentence punctuation is a boundary.
  const before = '(?:^|[\\s"“”`(\\[{: =]|(?<![\\p{L}\\p{N}_])[\'‘’])'
  const after = '(?=$|[\\s"“”`)\\]}]|[\'‘’](?![\\p{L}\\p{N}_])|[.,!?;:](?:\\s|$))'
  return new RegExp(before + escaped + after, 'u').test(text)
}

export async function intentInConversation(
  host: ExtensionHost,
  conversation: number,
  intent: string,
  parameter = false,
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
        const blocks =
          typeof message.content === 'string'
            ? [message.content]
            : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        // Never manufacture value bytes between text blocks; only intent allows normalization.
        if (parameter) {
          if (blocks.some((text) => parameterInText(text, intent))) return true
          continue
        }
        const text = blocks.join(' ')
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
