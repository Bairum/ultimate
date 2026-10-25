import { describe, expect, it, vi } from 'vitest'
import type { ClassifyService } from '../extensions/classify/api.ts'
import {
  activate,
  addEvidence,
  anchor,
  budgetGate,
  checkpoint,
  checkpointGate,
  completeSubgoal,
  confirmChange,
  confirmTask,
  finish,
  loopGate,
  markInterrupted,
  note,
  observeGate,
  oscillationGate,
  recordEscalation,
  recordObserve,
  recordStep,
  replan,
  requireActiveTask,
  scopeGate,
  setSubgoals,
  startTask,
} from '../extensions/computer-use/task.ts'
import type { TaskSpec, TaskState } from '../extensions/computer-use/task.ts'

const spec = (): TaskSpec => ({
  id: 'T1',
  intent: 'Export the sheet as PDF',
  goal: 'Export a PDF',
  criteria: [{ id: 'C1', text: 'PDF exists', check: [{ file: 'report.pdf' }] }],
  scope: {
    apps: ['Numbers'],
    params: { filename: 'report.pdf' },
    actions: ['click', 'type'],
    consequential: [],
  },
  stop: { steps: 60, minutes: 15, escalations: 6 },
})
function task() {
  return activate(
    setSubgoals(startTask(spec(), 1000).state, [{ id: 'S1', text: 'Export PDF' }]),
    'S1',
  )
}
function step(state: TaskState, hash = 'click', progress = false, outline?: string) {
  return recordStep(state, {
    actionHash: hash,
    delivered: true,
    verifiedProgress: progress,
    outlineFingerprint: outline,
    subgoal: 'S1',
  })
}
function ask(on_task = 0.9, progressing = 0.9): ClassifyService['ask'] {
  return vi.fn<ClassifyService['ask']>(async () => ({
    model: 'fake',
    usage: { inputTokens: 1 },
    answers: {
      on_task: { type: 'noul', noul: on_task },
      progressing: { type: 'noul', noul: progressing },
      intent_achieved: { type: 'noul', noul: 0.1 },
    },
  }))
}
const evidence = { kind: 'capture' as const, captureId: 'P1', ref: 'J1', app: 'Numbers' }

describe('computer task grounding', () => {
  it('starts active with defaults, preserving the verbatim intent; flags all confirmation reasons', () => {
    const input = spec()
    const started = startTask({ ...input, stop: undefined }, 1000)
    expect(started.state.status).toBe('active')
    expect(started.state.spec.stop).toEqual({ steps: 60, minutes: 15, escalations: 6 })
    expect(started.state.spec.intent).toBe(input.intent)
    input.goal = 'Send messages'
    input.criteria[0].check = 'evidence'
    input.scope.apps = ['A', 'B', 'C', 'D']
    input.scope.consequential = ['Send']
    const result = startTask(input, 1000)
    expect(result.needsConfirmation).toHaveLength(4)
    expect(requireActiveTask(result.state)?.refuse).toBe('task_awaiting_confirmation')
    expect(confirmTask(result.state).status).toBe('active')
    expect(requireActiveTask()?.refuse).toBe('no_task')
  })

  it('rejects invalid specs and duplicate ids', () => {
    for (const input of [
      { ...spec(), intent: ' ' },
      { ...spec(), criteria: [] },
      { ...spec(), scope: { ...spec().scope, apps: [] } },
      { ...spec(), criteria: [spec().criteria[0], spec().criteria[0]] },
    ])
      expect(() => startTask(input, 0)).toThrow(/required|duplicate/i)
  })

  it('refuses apps and action kinds outside scope', () => {
    expect(scopeGate(task(), { app: 'Mail', stepKind: 'click' })?.refuse).toBe('out_of_scope')
    expect(scopeGate(task(), { app: 'Numbers', stepKind: 'key' })?.refuse).toBe('out_of_scope')
    expect(scopeGate(task(), { app: 'Numbers', stepKind: 'click' })).toBeUndefined()
  })

  it('stops repeats until replan but ignores repeats separated by verified progress', () => {
    const initial = task()
    const repeated = step(step(step(initial)))
    expect(loopGate(repeated, { actionHash: 'click' })?.refuse).toBe('loop')
    expect(loopGate(repeated, { actionHash: 'different' })?.refuse).toBe('loop')
    expect(initial.counters.steps).toBe(0)
    const progressing = step(step(step(step(task()), 'click', true)))
    expect(loopGate(progressing, { actionHash: 'click' })).toBeUndefined()
    expect(
      loopGate(replan(repeated, { reason: 'Try a different control' }), { actionHash: 'click' }),
    ).toBeUndefined()
  })

  it('detects three outline oscillations', () => {
    let state = task()
    for (const [i, outline] of ['a', 'b', 'a', 'b', 'a', 'b'].entries())
      state = step(state, String(i), false, outline)
    expect(oscillationGate(state)?.refuse).toBe('loop')
  })

  it('requires checkpoints at ten steps and fifteen steps without a completed subgoal', async () => {
    let state = task()
    for (let i = 0; i < 10; i++) state = step(state, String(i), true)
    expect(checkpointGate(state)?.refuse).toBe('checkpoint_due')
    state = (await checkpoint(state, { assessment: 'Exporting', recentSteps: [] })).state
    for (let i = 0; i < 5; i++) state = step(state, String(i), true)
    expect(checkpointGate(state)?.refuse).toBe('checkpoint_due')
    const completed = completeSubgoal(addEvidence(state, 'S1', evidence), 'S1')
    expect('counters' in completed && completed.counters.sinceProgress).toBe(0)
  })

  it('lets a positive Jev checkpoint clear a stall that the planner alone cannot', async () => {
    let state = task()
    for (let i = 0; i < 15; i++) state = step(state, String(i), true)
    const alone = await checkpoint(state, { assessment: 'Still exporting', recentSteps: [] })
    expect(checkpointGate(alone.state)?.refuse).toBe('checkpoint_due')
    const judged = await checkpoint(state, { assessment: 'Still exporting', recentSteps: [] }, ask())
    expect(checkpointGate(judged.state)).toBeUndefined()
  })

  it('checkpoints with one Jev call; off-task cannot be cleared by another checkpoint', async () => {
    const judge = ask()
    const good = await checkpoint(
      task(),
      { assessment: 'On task', recentSteps: ['Clicked export'] },
      judge,
    )
    expect(judge).toHaveBeenCalledTimes(1)
    expect(good.refuse).toBeUndefined()
    const bad = await checkpoint(task(), { assessment: 'Drifting', recentSteps: [] }, ask(0.2))
    expect(bad.scores?.on_task).toBe(0.2)
    expect(checkpointGate(bad.state)?.refuse).toBe('replan_required')
    const retry = await checkpoint(bad.state, { assessment: 'Now good', recentSteps: [] }, ask())
    expect(checkpointGate(retry.state)?.refuse).toBe('replan_required')
    expect(checkpointGate(replan(retry.state, { reason: 'Return to export' }))).toBeUndefined()
  })

  it('records unavailable Jev without disabling code drift detectors', async () => {
    const state = { ...task(), drift: true }
    const result = await checkpoint(
      state,
      { assessment: 'Need review', recentSteps: [] },
      async () => {
        throw new Error('Offline')
      },
    )
    expect(result.state.ledger.at(-1)?.reason).toContain('"unavailable":true')
    expect(checkpointGate(result.state)?.refuse).toBe('checkpoint_due')
  })

  it('adds criteria freely; removing and changing criteria need user confirmation', () => {
    const added = replan(task(), {
      reason: 'Also check title',
      criteria: [...spec().criteria, { id: 'C2', text: 'Title visible', check: [{ title: true }] }],
    })
    expect(added.status).toBe('active')
    for (const criteria of [
      spec().criteria,
      [{ ...spec().criteria[0], check: 'evidence' as const }],
    ]) {
      const pending = replan(added, { reason: 'Reduce checks', criteria })
      expect(pending.spec.criteria).toHaveLength(2)
      expect(requireActiveTask(pending)?.refuse).toBe('task_awaiting_confirmation')
      expect(confirmChange(pending).spec.criteria).toEqual(criteria)
    }
  })

  it('confirms widened scope, narrows immediately and rejects intent changes', () => {
    const wider = { ...spec().scope, apps: ['Numbers', 'Finder'] }
    const pending = replan(task(), { reason: 'Inspect export', scope: wider })
    expect(pending.pendingChange).toBeDefined()
    const confirmed = confirmChange(pending)
    expect(confirmed.spec.scope.apps).toContain('Finder')
    expect(replan(confirmed, { reason: 'Only Numbers', scope: spec().scope }).status).toBe('active')
    expect(() =>
      replan(task(), { reason: 'Different task', intent: 'Send email' } as never),
    ).toThrow('immutable')
    expect(() => replan(task(), { reason: '' })).toThrow('reason is required')
  })

  it('allows only one active subgoal and requires extension evidence for completion', () => {
    const state = activate(
      setSubgoals(task(), [
        { id: 'S1', text: 'One' },
        { id: 'S2', text: 'Two' },
      ]),
      'S2',
    )
    expect(state.subgoals.filter((s) => s.status === 'active')).toHaveLength(1)
    expect(completeSubgoal(state, 'S2')).toMatchObject({ refuse: 'evidence_required' })
    const completed = completeSubgoal(addEvidence(state, 'S2', evidence), 'S2')
    expect('subgoals' in completed && completed.subgoals[1]?.status).toBe('done')
  })

  it('verifies every criterion at finish and never lets the optional judge decide', async () => {
    const state = addEvidence(task(), 'S1', evidence)
    const unmet = await finish(state, 'done', async () => 'unsatisfied')
    expect(unmet.refuse).toBe('criteria_unmet')
    expect(unmet.state.status).toBe('active')
    const input = spec()
    input.criteria.push({ id: 'C2', text: 'Capture', check: 'evidence' })
    let confirmed = confirmTask(startTask(input, 1000).state)
    confirmed = setSubgoals(confirmed, [{ id: 'S1', text: 'Export' }])
    confirmed = addEvidence(confirmed, 'S1', evidence)
    const verify = vi.fn<Parameters<typeof finish>[2]>(async () => 'satisfied')
    const done = await finish(confirmed, 'done', verify, ask())
    expect(verify).toHaveBeenCalledExactlyOnceWith(input.criteria[0].check)
    expect(done.state.status).toBe('done')
    expect(done.criteria.map((c) => c.state)).toEqual(['met', 'met'])
    expect(done.state.ledger.some((e) => e.kind === 'judge')).toBe(true)
  })

  it('always returns an honest partial or blocked table, including unknown verifications', async () => {
    for (const outcome of ['partial', 'blocked'] as const) {
      const result = await finish(task(), outcome, async () => 'unknown')
      expect(result.state.status).toBe(outcome)
      expect(result.criteria).toEqual([
        { id: 'C1', text: 'PDF exists', state: 'unknown', evidence: [] },
      ])
    }
  })

  it('enforces escalation and clock/step budgets', () => {
    let state = task()
    for (let i = 0; i < 6; i++) state = recordEscalation(state, 'no_effect', 2000 + i)
    expect(state.status).toBe('blocked')
    expect(state.ledger.at(-1)?.reason).toContain('blocked')
    expect(budgetGate(task(), 901000)?.refuse).toBe('budget')
    expect(
      budgetGate({ ...task(), counters: { ...task().counters, steps: 60 } }, 1000)?.refuse,
    ).toBe('budget')
  })

  it('requires observe after interruptions and invalidates touched-app evidence', () => {
    const state = addEvidence(task(), 'S1', evidence)
    expect(observeGate(markInterrupted(state, 'crash'))?.refuse).toBe('observe_first')
    expect(markInterrupted(state, 'stop').status).toBe('stopped')
    const takeover = markInterrupted(state, 'takeover', ['Numbers'])
    expect(takeover.status).toBe('paused_by_user')
    expect(takeover.subgoals[0]).toMatchObject({ status: 'needs_reverify', evidence: [] })
    expect(observeGate(recordObserve(takeover))).toBeUndefined()
    expect(markInterrupted(state, 'takeover', ['Mail']).subgoals[0]?.evidence).toHaveLength(1)
  })

  it('never renders or sends parameter values, even when echoed in planner and evidence text', async () => {
    const secret = 'private "filename"'
    const input = spec()
    input.scope.params = { filename: secret }
    input.intent += ` ${secret}`
    let state = setSubgoals(startTask(input, 1000).state, [{ id: 'S1', text: `Export ${secret}` }])
    state = activate(state, 'S1')
    state = addEvidence(state, 'S1', { kind: 'ax', snapshot: 'snap', excerpt: secret, ref: 'J2' })
    const judge = ask()
    state = (
      await checkpoint(
        state,
        { assessment: secret, recentSteps: [secret], app: 'Numbers', window: secret },
        judge,
      )
    ).state
    await finish(state, 'partial', async () => 'satisfied', judge)
    const sent = JSON.stringify(vi.mocked(judge).mock.calls)
    expect(sent).not.toContain('private')
    expect(note(state)).not.toContain('private')
    expect(note(state)).toContain('filename')
    expect(anchor(state)).not.toContain('private')
    expect(anchor(state).length).toBeLessThanOrEqual(500)
    expect(anchor(state)).toBe(anchor(state))
  })
})
