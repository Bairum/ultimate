import { expect, test } from 'vitest'
import { routingInstructions } from '../evals/routing-instructions.ts'

test.each([
  'Fix the typo directly; do not create an epic or delegate to workers.',
  'This is a small, clear change: make the minimal exact edit, verify the diff and report evidence.',
  'Inspect README.md, make only the exact typo correction, verify the diff and report back.',
  'This is a clear, tiny task: correct the intended typo only, verify the diff and report back.',
  "Implement the correction yourself. No epic, workers or reviewer. Don't delegate.",
  'Without workers, fix the typo directly; avoid planning and skip independent review.',
  'Directly fix the typo without an epic, workers, or review.',
  'Fix the typo directly, review your diff, test and submit. No epic or workers.',
  'Small, clear change: replace the typo in README.md, verify the diff and submit.',
])('tiny instructions allow negated workflow mentions: %s', (prompt) => {
  expect(routingInstructions(prompt)).toMatchObject({
    direct: true,
    plan: false,
    workers: false,
    reviewer: false,
  })
})

test.each([
  'Fix the typo. Create an epic, delegate to workers and get a reviewer.',
  'Fix the typo directly; plan the work, use workers and require an independent review.',
  'Fix directly without an epic, but use workers and a reviewer.',
  "Fix directly; don't create an epic, then delegate to workers.",
])('negative control: tiny routing rejects affirmative orchestration: %s', (prompt) => {
  const actual = routingInstructions(prompt)
  expect(actual.direct && !actual.plan && !actual.workers && !actual.reviewer).toBe(false)
})

test('negative control: mentioning a fix is not an instruction to implement directly', () => {
  expect(routingInstructions('Fix the typo using the normal workflow.').direct).toBe(false)
  expect(routingInstructions('Do not fix this directly; ask a worker instead.').direct).toBe(false)
})

test.each([
  'Plan the feature, delegate to workers and get a reviewer before submitting.',
  'Create an epic. Use workers for implementation and review the result.',
  'No need to implement directly; plan the feature, use workers and require review.',
  "Skip assessment and use the project's normal workflow (plan, workers, verify, review, workspace submit).",
])('feature instructions require affirmative plan, workers and review: %s', (prompt) => {
  expect(routingInstructions(prompt)).toMatchObject({ plan: true, workers: true, review: true })
})

test('assessment counts only when it is asked for', () => {
  expect(routingInstructions('Assess first and send one assessment; build nothing.').assess).toBe(
    true,
  )
  expect(routingInstructions('Do not implement yet, assess first.').assess).toBe(true)
  expect(routingInstructions('Fix it directly; no assessment needed.').assess).toBe(false)
  expect(routingInstructions('Skip the assessment and implement it now.').assess).toBe(false)
})

test.each([
  'Implement directly; no plan, workers or review.',
  "Implement directly. Don't plan. Don't delegate to workers. Skip review.",
  'Plan and use workers, but do not get a review.',
  'Plan and review the implementation without workers.',
  'Use workers and review their work; no epic or planning.',
])('negative control: feature routing rejects missing or negated workflow: %s', (prompt) => {
  const actual = routingInstructions(prompt)
  expect(actual.plan && actual.workers && actual.review).toBe(false)
})
