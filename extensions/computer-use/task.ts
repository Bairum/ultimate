import type { ClassifyService } from '../classify/api.ts'
import type { Escalation, Predicate, Step, Verdict } from './types.ts'

export type TaskSpec = {
  id: string
  intent: string
  goal: string
  criteria: { id: string; text: string; check: Predicate[] | 'evidence' }[]
  scope: {
    apps: string[]
    params: Record<string, string>
    actions: Step['kind'][]
    consequential: string[]
  }
  stop: { steps: number; minutes: number; escalations: number }
  link?: { conversation: number; task?: string }
}
export type Evidence = (
  | { kind: 'verify'; predicates: Predicate[]; verdict: Verdict; ref: string }
  | { kind: 'ax'; snapshot: string; excerpt: string; ref: string }
  | { kind: 'capture'; captureId: string; path?: string; ref: string }
) & { app?: string }
export type Subgoal = {
  id: string
  text: string
  status: 'pending' | 'active' | 'done' | 'blocked' | 'skipped' | 'needs_reverify'
  attempts: number
  evidence: Evidence[]
}
export type Replan = {
  reason: string
  subgoals?: { id: string; text: string }[]
  criteria?: TaskSpec['criteria']
  scope?: TaskSpec['scope']
}
export type TaskState = {
  spec: TaskSpec
  status:
    | 'awaiting_confirmation'
    | 'active'
    | 'stopped'
    | 'paused_by_user'
    | 'done'
    | 'partial'
    | 'blocked'
  subgoals: Subgoal[]
  ledger: { at: number; kind: string; reason: string; ref?: string }[]
  counters: {
    steps: number
    startedAt: number
    sinceCheckpoint: number
    sinceProgress: number
    escalations: number
  }
  recent: { actions: string[]; outlines: string[] }
  needsObserve: boolean
  drift?: boolean
  replanRequired?: boolean
  loopDetected?: boolean
  criteriaMet?: string[]
  pendingChange?: Replan
}
export type Refusal = { refuse: string; message: string }
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
  validate(spec)
  const needsConfirmation: string[] = []
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
  log(next, 'confirmed', 'User confirmed task', now)
  return next
}
export function requireActiveTask(state?: TaskState): Refusal | undefined {
  if (!state) return refuse('no_task', 'Start a computer task first')
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
/** Driver results only: do not accept Evidence from tool/model arguments. */
export function addEvidence(state: TaskState, subgoalId: string, evidence: Evidence): TaskState {
  const next = copy(state)
  const subgoal = next.subgoals.find((s) => s.id === subgoalId)
  if (!subgoal) throw new Error('Unknown subgoal')
  subgoal.evidence.push(structuredClone(evidence))
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
  if (!subgoal?.evidence.length) return refuse('evidence_required', 'Driver evidence is required')
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
  for (const value of values.filter(Boolean).toSorted((a, b) => b.length - a.length)) {
    text = text.split(value).join('[param]')
    text = text.split(JSON.stringify(value).slice(1, -1)).join('[param]')
  }
  return text
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
  if (changedCriteria || widened) {
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
) {
  const next = copy(state)
  const evidence = next.subgoals
    .filter((s) => s.status !== 'needs_reverify')
    .flatMap((s) => s.evidence)
  const criteria = await Promise.all(
    next.spec.criteria.map(async (c) => {
      let verdict: Verdict = 'unknown'
      if (c.check === 'evidence') verdict = evidence.length ? 'satisfied' : 'unsatisfied'
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
