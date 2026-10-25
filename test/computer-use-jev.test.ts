import { expect, it, vi } from 'vitest'
import type { ClassifyService } from '../extensions/classify/api.ts'
import { runGoal } from '../extensions/computer-use/jev.ts'
import type { GoalDeps } from '../extensions/computer-use/jev.ts'
import { consequential } from '../extensions/computer-use/policy.ts'
import type { Element, Goal, Observation } from '../extensions/computer-use/types.ts'

const element = (index: number, role: string, label: string, value?: string): Element => ({
  index,
  token: `s1:${index}`,
  role,
  label,
  value,
  depth: 0,
  enabled: true,
  actions: [],
})
const goal: Goal = {
  text: 'Fill Name then tick I agree',
  params: { Name: 'private-value' },
  done_when: [{ label: 'I agree', value: '1' }],
}

function fixture(
  options: {
    p?: number
    second?: number
    risk?: number
    done?: number
    effect?: boolean
    pick?: string
  } = {},
) {
  let elements = [
    element(1, 'AXTextField', 'Name', ''),
    element(2, 'AXCheckBox', 'I agree', '0'),
    element(3, 'AXButton', 'Submit'),
  ]
  const states: unknown[] = []
  const tables: Record<string, unknown>[] = []
  const observe = vi.fn<GoalDeps['observe']>(async (): Promise<Observation> => ({
    app: 'Form',
    pid: 1,
    windowId: 1,
    title: 'Form',
    snapshot: 's1',
    tree: '',
    truncated: false,
    elements: structuredClone(elements),
  }))
  const ask = vi.fn<ClassifyService['ask']>(async ({ state, questions }) => {
    states.push(structuredClone(state))
    if (questions.next.type !== 'choice') throw new Error('Expected choice')
    const criteria = questions.next.criteria
    tables.push(criteria)
    const desired = elements[0].value ? 'checkbox: I agree' : 'text_input: Name'
    const id =
      options.pick ??
      Object.keys(criteria).find(
        (candidateId) =>
          typeof criteria[candidateId] === 'string' && criteria[candidateId].startsWith(desired),
      )!
    return {
      model: 'fake',
      usage: { inputTokens: 0 },
      answers: {
        next: {
          type: 'choice',
          choice: id,
          confidence: options.p ?? 0.95,
          probabilities: { [id]: options.p ?? 0.95, abstain: options.second ?? 0.05 },
        },
        done: { type: 'noul', noul: options.done ?? (elements[1].value === '1' ? 0.95 : 0) },
        risk: { type: 'noul', noul: options.risk ?? 0 },
      },
    }
  })
  const deps: GoalDeps = {
    app: 'Form',
    observe,
    ask,
    verify: vi.fn<GoalDeps['verify']>(async () => 'satisfied'),
    act: vi.fn<GoalDeps['act']>(async (candidate) => {
      if (options.effect !== false)
        elements = elements.map((e) =>
          e.index === candidate.element.index
            ? { ...e, value: candidate.value ?? '1', token: `s2:${e.index}` }
            : e,
        )
      return { status: 'delivered', text: 'ok' }
    }),
    allowed: (c) =>
      consequential({ kind: 'click', element: c.element.token }, c.element).hit
        ? 'consequential'
        : 'ok',
    stopped: () => false,
    signal: new AbortController().signal,
    now: () => 0,
    record: vi.fn<GoalDeps['record']>(),
  }
  return {
    deps,
    states,
    tables,
    ask,
    observe,
    setElements: (next: Element[]) => {
      elements = next
    },
  }
}

it('fills a fake form, verifies each effect and completes only on verified done', async () => {
  const f = fixture()
  const result = await runGoal(goal, f.deps)
  expect(result).toMatchObject({ status: 'done', steps: 2, verdict: 'satisfied' })
  expect(f.deps.act).toHaveBeenCalledTimes(2)
  expect(f.deps.verify).toHaveBeenCalledWith(goal.done_when)
  expect(f.deps.record).toHaveBeenCalledTimes(result.decisions.length)
  expect(result.decisions.filter((d) => d.outcome === 'verified')).toHaveLength(2)
  expect(JSON.stringify(f.states)).not.toContain('private-value')
  expect(f.tables.every((table) => !JSON.stringify(table).includes('Submit'))).toBe(true)
  expect(f.tables[0]).toMatchObject({ reobserve: expect.any(String), abstain: expect.any(String) })
})

it.each([
  [{ p: 0.79 }, 'low_confidence'],
  [{ p: 0.81, second: 0.6 }, 'low_confidence'],
  [{ risk: 0.31 }, 'consequential'],
] as const)('escalates %j without dispatching', async (options, reason) => {
  const f = fixture(options)
  expect(await runGoal(goal, f.deps)).toMatchObject({
    status: 'escalated',
    reason,
    observation: expect.any(Object),
  })
  expect(f.deps.act).not.toHaveBeenCalled()
})

it('reobserves a missing effect once, then escalates without a second act', async () => {
  const f = fixture({ effect: false })
  expect(await runGoal(goal, f.deps)).toMatchObject({
    status: 'escalated',
    reason: 'no_effect',
    steps: 1,
  })
  expect(f.observe).toHaveBeenCalledTimes(3)
  expect(f.deps.act).toHaveBeenCalledTimes(1)
})

it('requires verifiable done and never treats unknown as satisfied', async () => {
  const f = fixture({ done: 0.9 })
  expect(await runGoal({ text: 'Fill Name', params: goal.params }, f.deps)).toMatchObject({
    reason: 'unverifiable_done',
  })
  f.deps.verify = vi.fn<GoalDeps['verify']>(async () => 'unknown')
  expect(await runGoal(goal, f.deps)).toMatchObject({ reason: 'unverified_done' })
  expect(f.deps.act).not.toHaveBeenCalled()
})

it('escalates unavailable Jev both before and after a verified action', async () => {
  const f = fixture()
  f.deps.ask = undefined
  expect(await runGoal(goal, f.deps)).toMatchObject({ reason: 'jev_unavailable' })
  f.deps.ask = f.ask
  f.ask.mockImplementationOnce(async () => {
    throw new Error('offline')
  })
  expect(await runGoal(goal, f.deps)).toMatchObject({ reason: 'jev_unavailable' })
  f.ask
    .mockImplementationOnce(async ({ questions }) => {
      if (questions.next.type !== 'choice') throw new Error('Expected choice')
      const id = Object.keys(questions.next.criteria)[0]
      return {
        model: 'fake',
        usage: { inputTokens: 0 },
        answers: {
          next: { type: 'choice', choice: id, confidence: 1, probabilities: { [id]: 1 } },
          done: { type: 'noul', noul: 0 },
          risk: { type: 'noul', noul: 0 },
        },
      }
    })
    .mockImplementationOnce(async () => {
      throw new Error('offline after act')
    })
  expect(await runGoal(goal, f.deps)).toMatchObject({ reason: 'jev_unavailable', steps: 1 })
  expect(f.deps.act).toHaveBeenCalledTimes(1)
})

it('enforces step and elapsed budgets without real waits', async () => {
  const f = fixture()
  expect(await runGoal({ ...goal, budget: { steps: 1 } }, f.deps)).toMatchObject({
    reason: 'budget',
    steps: 1,
  })
  const timed = fixture()
  let time = 0
  timed.deps.now = () => time++ * 31_000
  expect(await runGoal(goal, timed.deps)).toMatchObject({ reason: 'budget', steps: 0 })
  expect(timed.deps.act).not.toHaveBeenCalled()
})

it('refuses empty trees and bounds model-requested reobservation', async () => {
  const empty = fixture()
  empty.setElements([element(1, 'AXWindow', 'Window'), element(2, 'AXButton', 'Close')])
  expect(await runGoal(goal, empty.deps)).toMatchObject({ reason: 'no_candidates' })
  expect(empty.ask).not.toHaveBeenCalled()
  const f = fixture({ pick: 'reobserve' })
  expect(await runGoal(goal, f.deps)).toMatchObject({ reason: 'low_confidence' })
  expect(f.observe).toHaveBeenCalledTimes(2)
  expect(f.deps.act).not.toHaveBeenCalled()
})

it('honours stop immediately before dispatch and reports driver refusals', async () => {
  const f = fixture()
  f.deps.stopped = () => f.ask.mock.calls.length > 0
  expect(await runGoal(goal, f.deps)).toMatchObject({ reason: 'stopped' })
  expect(f.deps.act).not.toHaveBeenCalled()
  const refused = fixture()
  refused.deps.act = vi.fn<GoalDeps['act']>(async () => ({
    status: 'refused',
    code: 'stale_ref',
    message: 'stale',
  }))
  expect(await runGoal(goal, refused.deps)).toMatchObject({
    reason: 'refused',
    detail: 'stale_ref',
  })
})
