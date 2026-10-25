import { isDeepStrictEqual } from 'node:util'
import { redactor } from './content.ts'
import type { ClassifyService } from '../classify/api.ts'
import type {
  Approval,
  Escalation,
  Observation,
  Predicate,
  PracticeCheck,
  Step,
  Verdict,
} from './types.ts'
import type { Evidence, Replan, TaskSpec, TaskState, Refusal } from './types.ts'
export type { Evidence, Replan, Subgoal, TaskSpec, TaskState, Refusal } from './types.ts'

type Ask = ClassifyService['ask']
const refuse = (code: string, message: string): Refusal => ({ refuse: code, message })
const copy = (state: TaskState): TaskState => structuredClone(state)
function log(state: TaskState, kind: string, reason: string, now?: number) {
  state.ledger.push({
    at: now ?? state.ledger.at(-1)?.at ?? state.counters.startedAt,
    kind,
    reason: redact(state, reason),
  })
}
function unique(ids: string[]) {
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length)
    throw new Error('Empty or duplicate ids')
}
export function validateApproval(raw: unknown): asserts raw is Approval {
  const value = raw as Record<string, unknown>
  const kinds = [
    'click',
    'double_click',
    'right_click',
    'type',
    'set_value',
    'key',
    'scroll',
    'menu',
    'wait',
  ]
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    typeof value.app !== 'string' ||
    !value.app.trim() ||
    value.pixel !== true ||
    typeof value.foreground !== 'boolean' ||
    !Array.isArray(value.actions) ||
    !value.actions.length ||
    value.actions.some((kind) => !kinds.includes(kind)) ||
    typeof value.steps !== 'number' ||
    !Number.isSafeInteger(value.steps) ||
    value.steps < 1 ||
    value.steps > 200 ||
    typeof value.minutes !== 'number' ||
    !Number.isFinite(value.minutes) ||
    value.minutes <= 0 ||
    value.minutes > 60 ||
    (value.window !== undefined &&
      !(typeof value.window === 'string'
        ? value.window.trim()
        : typeof value.window === 'number' &&
          Number.isSafeInteger(value.window) &&
          value.window > 0))
  )
    throw new Error('Invalid task approval')
}
export function approvalScope(
  state: TaskState,
  identity: { name: string; bundle?: string },
  observation: Pick<Observation, 'windowId' | 'title'>,
  kind: Step['kind'],
) {
  const approval = state.spec.approval
  return (
    state.status === 'active' &&
    !!approval &&
    [identity.name, identity.bundle].some(
      (name) => name?.toLowerCase() === approval.app.toLowerCase(),
    ) &&
    approval.actions.includes(kind) &&
    (approval.window === undefined ||
      (typeof approval.window === 'number'
        ? observation.windowId === approval.window
        : observation.title.includes(approval.window)))
  )
}
function validate(spec: TaskSpec) {
  if (!spec.id.trim() || !spec.intent.trim() || !spec.goal.trim())
    throw new Error('Task id, intent and goal are required')
  if (!spec.criteria.length || !spec.scope.apps.length)
    throw new Error('Criteria and scoped apps are required')
  unique(spec.criteria.map((c) => c.id))
  if (spec.criteria.some((c) => !c.text.trim() || (c.check !== 'evidence' && !c.check.length)))
    throw new Error('Each criterion needs text and a check')
  if (Object.values(spec.stop).some((n) => !Number.isFinite(n) || n <= 0))
    throw new Error('Invalid stop budget')
  if (spec.approval) validateApproval(spec.approval)
}
const stopwords = new Set(
  'a an the to of in on at for and or with from as is it my me please this that i you'.split(' '),
)
function words(text: string) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !stopwords.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, ''))
}
export function startTask(
  input: Omit<TaskSpec, 'stop'> & { stop?: Partial<TaskSpec['stop']> },
  now: number,
) {
  const spec: TaskSpec = structuredClone({
    ...input,
    stop: { steps: 60, minutes: 15, escalations: 6, ...input.stop },
  })
  if (spec.approval) {
    spec.stop.steps = spec.approval.steps
    spec.stop.minutes = spec.approval.minutes
  }
  validate(spec)
  const needsConfirmation: string[] = []
  if (spec.approval) needsConfirmation.push('Scoped computer approval')
  if (spec.criteria.some((c) => c.check === 'evidence'))
    needsConfirmation.push('Evidence-only criterion')
  if (spec.scope.apps.length > 3) needsConfirmation.push('More than three apps')
  if (spec.scope.consequential.length) needsConfirmation.push('Consequential actions')
  if (!words(spec.intent).some((word) => words(spec.goal).includes(word)))
    needsConfirmation.push('Intent and goal differ')
  const state: TaskState = {
    spec,
    status: needsConfirmation.length ? 'awaiting_confirmation' : 'active',
    subgoals: [],
    ledger: [],
    counters: { steps: 0, startedAt: now, sinceCheckpoint: 0, sinceProgress: 0, escalations: 0 },
    recent: { actions: [], outlines: [] },
    needsObserve: false,
  }
  log(state, 'start', needsConfirmation.join('; ') || 'Task active', now)
  return { state, needsConfirmation }
}
/** User-only: the server must authenticate the confirmation, never expose it as a model action. */
export function confirmTask(state: TaskState, now?: number): TaskState {
  if (state.status !== 'awaiting_confirmation' || state.pendingChange)
    throw new Error('No initial confirmation pending')
  const next = copy(state)
  next.status = 'active'
  next.runTakeover = !!next.spec.approval?.foreground
  next.counters.startedAt = now ?? Date.now()
  log(next, 'confirmed', 'User confirmed task', now)
  return next
}
export function requireActiveTask(state?: TaskState): Refusal | undefined {
  if (!state) return refuse('no_task', 'Start a computer task first')
  if (state.practiceMismatch)
    return refuse('practice_mismatch', 'Practice mismatched; finish partial or blocked')
  if (state.status !== 'active') return refuse(`task_${state.status}`, 'Task is not active')
  return undefined
}
export function scopeGate(
  state: TaskState,
  input: { app: string; stepKind: Step['kind'] },
): Refusal | undefined {
  if (
    !state.spec.scope.apps.includes(input.app) ||
    !state.spec.scope.actions.includes(input.stepKind)
  )
    return refuse('out_of_scope', 'App or action is outside the task scope')
  return undefined
}
export function loopGate(state: TaskState, input: { actionHash: string }): Refusal | undefined {
  if (
    state.loopDetected ||
    state.recent.actions.filter((hash) => hash === input.actionHash).length >= 3
  )
    return refuse('loop', 'Repeated action without verified progress; replan required')
  return undefined
}
export function oscillationGate(state: TaskState): Refusal | undefined {
  const values = state.recent.outlines.slice(-6)
  if (values.length === 6 && values[0] !== values[1] && values.every((v, i) => v === values[i % 2]))
    return refuse('loop', 'Outline oscillation; replan required')
  return undefined
}
export function checkpointGate(state: TaskState): Refusal | undefined {
  if (state.replanRequired) return refuse('replan_required', 'Checkpoint requires a replan')
  if (state.counters.sinceCheckpoint >= 10 || state.counters.sinceProgress >= 15 || state.drift)
    return refuse('checkpoint_due', 'Assess progress before continuing')
  return undefined
}
export function budgetGate(state: TaskState, now: number): Refusal | undefined {
  if (
    state.counters.steps >= state.spec.stop.steps ||
    now - state.counters.startedAt >= state.spec.stop.minutes * 60_000
  )
    return refuse('budget', 'Task budget exhausted; finish as partial')
  return undefined
}
export function observeGate(state: TaskState): Refusal | undefined {
  if (state.needsObserve) return refuse('observe_first', 'Observe again before acting')
  return undefined
}
export function recordStep(
  state: TaskState,
  input: {
    actionHash: string
    delivered: boolean
    verifiedProgress: boolean
    outlineFingerprint?: string
    subgoal: string
  },
): TaskState {
  const next = copy(state)
  const subgoal = next.subgoals.find((s) => s.id === input.subgoal && s.status === 'active')
  if (!subgoal) throw new Error('Step must serve the active subgoal')
  subgoal.attempts++
  next.counters.steps++
  next.counters.sinceCheckpoint++
  next.counters.sinceProgress++
  if (input.delivered && input.verifiedProgress) next.recent = { actions: [], outlines: [] }
  else next.recent.actions = [...next.recent.actions, input.actionHash].slice(-20)
  if (input.outlineFingerprint)
    next.recent.outlines = [...next.recent.outlines, input.outlineFingerprint].slice(-6)
  if (loopGate(next, input) || oscillationGate(next)) next.loopDetected = true
  return next
}
export function recordEscalation(state: TaskState, reason: Escalation, now?: number): TaskState {
  const next = copy(state)
  next.counters.escalations++
  if (next.counters.escalations >= next.spec.stop.escalations) next.status = 'blocked'
  log(next, 'escalation', `${reason}; task ${next.status}`, now)
  return next
}
export function recordObserve(state: TaskState): TaskState {
  return { ...copy(state), needsObserve: false }
}
export function markInterrupted(
  state: TaskState,
  event: 'stop' | 'takeover' | 'crash',
  touchedApps: string[] = [],
  now?: number,
) {
  const next = copy(state)
  next.runTakeover = false
  next.needsObserve = true
  if (event === 'stop') next.status = 'stopped'
  if (event === 'takeover') {
    next.status = 'paused_by_user'
    for (const subgoal of next.subgoals) {
      if (subgoal.evidence.some((e) => !e.app || touchedApps.includes(e.app))) {
        subgoal.status = 'needs_reverify'
        subgoal.evidence = []
      }
    }
  }
  log(next, 'interrupted', event, now)
  return next
}
/** Only matching Driver predicates prove objective progress; a model-selected tag never does. */
export function predicateEvidence(state: TaskState, evidence: Evidence): boolean {
  return (
    evidence.kind === 'verify' &&
    evidence.verdict === 'satisfied' &&
    state.spec.criteria.some(
      (c) => c.check !== 'evidence' && isDeepStrictEqual(c.check, evidence.predicates),
    )
  )
}
export function linkedEvidence(state: TaskState, evidence: Evidence): boolean {
  if (evidence.kind === 'verify' && evidence.verdict !== 'satisfied') return false
  return (
    predicateEvidence(state, evidence) ||
    state.spec.criteria.some((c) => c.check === 'evidence' && c.id === evidence.criterion)
  )
}
/** Driver results only: do not accept Evidence from tool/model arguments. */
export function addEvidence(state: TaskState, subgoalId: string, evidence: Evidence): TaskState {
  const next = copy(state)
  const subgoal = next.subgoals.find((s) => s.id === subgoalId)
  if (!subgoal) throw new Error('Unknown subgoal')
  const item = structuredClone(evidence)
  if (item.kind === 'ax')
    item.excerpt = redactor(Object.values(state.spec.scope.params))(item.excerpt)
  // The same proof recorded twice (finish re-verifying a step's predicates) adds nothing.
  if (!subgoal.evidence.some((e) => JSON.stringify(e) === JSON.stringify(item)))
    subgoal.evidence.push(item)
  return next
}
export function setSubgoals(
  state: TaskState,
  subgoals: { id: string; text: string }[],
  now?: number,
): TaskState {
  unique(subgoals.map((s) => s.id))
  const next = copy(state)
  next.subgoals = subgoals.map((s) => ({ ...s, status: 'pending', attempts: 0, evidence: [] }))
  log(next, 'subgoals', JSON.stringify(subgoals), now)
  return next
}
export function activate(state: TaskState, id: string, now?: number): TaskState {
  const next = copy(state)
  if (!next.subgoals.some((s) => s.id === id)) throw new Error('Unknown subgoal')
  for (const subgoal of next.subgoals) {
    if (subgoal.id === id) subgoal.status = 'active'
    else if (subgoal.status === 'active') subgoal.status = 'pending'
  }
  log(next, 'activate', id, now)
  return next
}
export function completeSubgoal(state: TaskState, id: string, now?: number): TaskState | Refusal {
  const next = copy(state)
  const subgoal = next.subgoals.find((s) => s.id === id)
  if (!subgoal?.evidence.some((e) => linkedEvidence(state, e)))
    return refuse('evidence_required', 'Criterion-linked Driver evidence is required')
  subgoal.status = 'done'
  next.counters.sinceProgress = 0
  log(next, 'subgoal_done', id, now)
  return next
}
/** Redact even values echoed in intent, observations, planner text or ledger entries. */
function redact(state: TaskState, text: string): string {
  const values = [
    ...Object.values(state.spec.scope.params),
    ...Object.values(state.pendingChange?.scope?.params ?? {}),
  ]
  return redactor(values)(text)
}
function judgeState(state: TaskState, details: unknown) {
  return JSON.parse(
    JSON.stringify(
      {
        intent: state.spec.intent,
        goal: state.spec.goal,
        subgoal: state.subgoals.find((s) => s.status === 'active')?.text ?? '',
        details,
      },
      (_key, value: unknown) => (typeof value === 'string' ? redact(state, value) : value),
    ),
  )
}
export async function checkpoint(
  state: TaskState,
  input: { assessment: string; recentSteps: string[]; app?: string; window?: string },
  ask?: Ask,
  signal: AbortSignal = new AbortController().signal,
  now?: number,
) {
  const next = copy(state)
  let scores: { on_task: number; progressing: number } | undefined
  let unavailable = false
  if (ask) {
    try {
      const result = await ask(
        {
          state: judgeState(state, input),
          questions: {
            on_task: { type: 'noul', instructions: 'Is the recent activity serving the intent?' },
            progressing: {
              type: 'noul',
              instructions: 'Did the last steps move the active subgoal forward?',
            },
          },
        },
        signal,
      )
      const on = result.answers.on_task
      const progress = result.answers.progressing
      if (
        on?.type !== 'noul' ||
        progress?.type !== 'noul' ||
        ![on.noul, progress.noul].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
      )
        throw new Error('Invalid checkpoint answer')
      scores = { on_task: on.noul, progressing: progress.noul }
    } catch {
      // Classify is optional: an unavailable judge falls back to the recorded planner assessment, never disables code gates.
      unavailable = true
    }
  }
  if (scores && (scores.on_task < 0.5 || scores.progressing < 0.5)) next.replanRequired = true
  else {
    next.counters.sinceCheckpoint = 0
    // Only an independent judge clears a stall: without Jev, no progress or drift still needs a replan.
    if (scores) {
      next.counters.sinceProgress = 0
      next.drift = false
    }
  }
  log(
    next,
    'checkpoint',
    JSON.stringify({
      assessment: input.assessment,
      scores,
      unavailable,
      step: next.counters.steps,
    }),
    now,
  )
  return {
    state: next,
    scores,
    ...(next.replanRequired ? refuse('replan_required', 'Replan before acting') : {}),
  }
}
function applyReplan(state: TaskState, change: Replan, now?: number): TaskState {
  let next = copy(state)
  if (change.subgoals) next = setSubgoals(next, change.subgoals, now)
  if (change.criteria) next.spec.criteria = structuredClone(change.criteria)
  if (change.scope) next.spec.scope = structuredClone(change.scope)
  if (change.approval) {
    next.spec.approval = structuredClone(change.approval)
    next.spec.stop.steps = change.approval.steps
    next.spec.stop.minutes = change.approval.minutes
    if (!change.approval.foreground) next.runTakeover = false
  }
  next.drift = false
  next.replanRequired = false
  next.loopDetected = false
  next.criteriaMet = []
  next.counters.sinceProgress = 0
  next.counters.sinceCheckpoint = 0
  next.recent = { actions: [], outlines: [] }
  delete next.pendingChange
  log(next, 'replan', JSON.stringify(change), now)
  return next
}
export function replan(state: TaskState, change: Replan, now?: number): TaskState {
  if ('intent' in change || 'spec' in change)
    throw new Error('Intent is immutable; start a new task')
  if (!change.reason.trim()) throw new Error('Replan reason is required')
  if (state.status !== 'active') throw new Error('Task is not active')
  validate({
    ...state.spec,
    criteria: change.criteria ?? state.spec.criteria,
    scope: change.scope ?? state.spec.scope,
    approval: change.approval ?? state.spec.approval,
  })
  if (change.subgoals) unique(change.subgoals.map((s) => s.id))
  const changedCriteria =
    change.criteria &&
    state.spec.criteria.some(
      (old) =>
        !change.criteria!.some((c) => c.id === old.id && JSON.stringify(c) === JSON.stringify(old)),
    )
  const widened =
    change.scope &&
    (['apps', 'actions', 'consequential'] as const).some((key) =>
      change.scope![key].some((value) => !(state.spec.scope[key] as string[]).includes(value)),
    )
  const previous = state.spec.approval
  const proposed = change.approval
  const approvalWidened =
    proposed &&
    (!previous ||
      proposed.app.toLowerCase() !== previous.app.toLowerCase() ||
      (previous.window !== undefined &&
        proposed.window !== previous.window &&
        !(
          typeof proposed.window === 'string' &&
          typeof previous.window === 'string' &&
          proposed.window.includes(previous.window)
        )) ||
      proposed.actions.some((kind) => !previous.actions.includes(kind)) ||
      proposed.steps > previous.steps ||
      proposed.minutes > previous.minutes ||
      (proposed.foreground && !previous.foreground))
  if (changedCriteria || widened || approvalWidened) {
    let next = copy(state)
    if (change.subgoals) next = setSubgoals(next, change.subgoals, now)
    const existing = new Set(next.spec.criteria.map((c) => c.id))
    next.spec.criteria.push(
      ...structuredClone(change.criteria?.filter((c) => !existing.has(c.id)) ?? []),
    )
    next.status = 'awaiting_confirmation'
    next.pendingChange = structuredClone(change)
    log(next, 'change_pending', JSON.stringify(change), now)
    return next
  }
  return applyReplan(state, change, now)
}
/** User-only, like confirmTask. */
export function confirmChange(state: TaskState, now?: number): TaskState {
  if (state.status !== 'awaiting_confirmation' || !state.pendingChange)
    throw new Error('No change pending')
  const next = applyReplan(state, state.pendingChange, now)
  next.status = 'active'
  next.runTakeover = !!next.spec.approval?.foreground
  log(next, 'confirmed', 'User confirmed replan', now)
  return next
}
export async function finish(
  state: TaskState,
  outcome: 'done' | 'partial' | 'blocked',
  verify: (predicates: Predicate[]) => Promise<Verdict>,
  ask?: Ask,
  signal: AbortSignal = new AbortController().signal,
  now?: number,
  proof?: { criteria: TaskSpec['criteria']; checks: PracticeCheck[] },
) {
  const next = copy(state)
  if (outcome === 'done' && state.practiceMismatch)
    return { state: next, refuse: 'practice_mismatch', criteria: [] }
  if (proof && outcome === 'done') {
    let previous = -Infinity
    const valid =
      isDeepStrictEqual(proof.criteria, state.spec.criteria) &&
      proof.checks.length === proof.criteria.length * 2 &&
      proof.checks.every((check, i) => {
        const ordered =
          check.step === Math.floor(i / 2) + 1 &&
          check.phase === (i % 2 ? 'after' : 'before') &&
          Number.isFinite(check.at) &&
          check.at > previous &&
          !!check.capture &&
          !!check.ref
        previous = check.at
        return (
          ordered &&
          (i % 2 === 0 ||
            isDeepStrictEqual(check.predicates, proof.criteria[Math.floor(i / 2)].check))
        )
      })
    if (!valid) return { state: next, refuse: 'practice_checks_required', criteria: [] }
  }
  const evidence = next.subgoals
    .filter((s) => s.status !== 'needs_reverify')
    .flatMap((s) => s.evidence)
  const criteria = await Promise.all(
    next.spec.criteria.map(async (c, index) => {
      let verdict: Verdict = 'unknown'
      if (proof && !(outcome === 'done' && index === next.spec.criteria.length - 1))
        verdict = proof.checks.some(
          (check) =>
            check.step === index + 1 &&
            check.phase === 'after' &&
            isDeepStrictEqual(check.predicates, c.check),
        )
          ? 'satisfied'
          : 'unknown'
      else if (c.check === 'evidence')
        verdict = evidence.some((e) => e.criterion === c.id) ? 'satisfied' : 'unsatisfied'
      else {
        try {
          verdict = await verify(structuredClone(c.check))
        } catch {
          /* Failed verification is unknown, never success; partial reports must still be available. */
        }
      }
      return {
        id: c.id,
        text: c.text,
        state:
          verdict === 'satisfied'
            ? ('met' as const)
            : verdict === 'unsatisfied'
              ? ('unmet' as const)
              : ('unknown' as const),
        evidence: structuredClone(evidence),
      }
    }),
  )
  if (ask) {
    try {
      const result = await ask(
        {
          state: judgeState(next, criteria),
          questions: {
            intent_achieved: { type: 'noul', instructions: 'Is the original intent achieved?' },
          },
        },
        signal,
      )
      log(next, 'judge', JSON.stringify(result.answers.intent_achieved), now)
    } catch {
      log(next, 'judge', 'Judge unavailable; criteria remain authoritative', now)
    }
  }
  next.criteriaMet = criteria.filter((c) => c.state === 'met').map((c) => c.id)
  const unmet = criteria.filter((c) => c.state !== 'met').map((c) => c.id)
  if (outcome === 'done' && unmet.length)
    return { state: next, refuse: 'criteria_unmet', unmet, criteria }
  next.status = outcome
  next.runTakeover = false
  log(next, 'finish', outcome, now)
  return { state: next, criteria }
}
export function anchor(state: TaskState): string {
  const active = state.subgoals.find((s) => s.status === 'active')
  const last = state.ledger.findLast((entry) => entry.kind === 'checkpoint')
  const text = `Task ${state.spec.id} · intent: "${redact(state, state.spec.intent).slice(0, 120)}" · ${active?.id ?? '-'}/${state.subgoals.length} active: "${redact(state, active?.text ?? '-').slice(0, 65)}" · criteria ${state.criteriaMet?.length ?? 0}/${state.spec.criteria.length} met · steps ${state.counters.steps}/${state.spec.stop.steps} · scope: ${state.spec.scope.apps.join(', ')} · last check: ${last?.reason ?? 'none'}`
  return redact(state, text).slice(0, 500)
}
export function note(state: TaskState): string {
  const spec = {
    ...state.spec,
    scope: { ...state.spec.scope, params: Object.keys(state.spec.scope.params) },
  }
  const markers = {
    done: 'x',
    active: '>',
    pending: ' ',
    skipped: '-',
    blocked: '!',
    needs_reverify: '!',
  }
  return redact(
    state,
    [
      JSON.stringify(spec),
      ...state.subgoals.map((s) => `[${markers[s.status]}] ${s.id}: ${s.text}`),
      ...state.ledger.slice(-5).map((entry) => `${entry.at} ${entry.kind}: ${entry.reason}`),
    ].join('\n'),
  )
}
