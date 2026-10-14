import { expect, it } from 'vitest'
import { inProgress, superseded } from '../../extensions/workspaces/steps.tsx'
import type { LanderStep } from '../../extensions/workspaces/types.ts'

/** The rows a landing submission's card shows, and which of them spin, as `Steps` in log.tsx decides. */
function card(steps: LanderStep[]) {
  const rows = steps.filter((row, index) => !superseded(row, steps.slice(index + 1)))
  return rows.map((row, index) => ({
    row: row.step,
    spinning: inProgress(row, rows.slice(index + 1)),
  }))
}

it('shows a finished group check with its result while its sibling still spins', () => {
  const steps: LanderStep[] = [
    { step: 'setting up', at: 1 },
    { step: 'checking: a', at: 2 },
    { step: 'checking: b', at: 3 },
    { step: 'checked: a', at: 4, check: { command: 'a', result: 'passed', summary: 'a ok' } },
  ]
  expect(card(steps)).toEqual([
    { row: 'setting up', spinning: false },
    { row: 'checking: b', spinning: true },
    { row: 'checked: a', spinning: false },
  ])
  // B's result replaces its running row; then nothing in the group spins.
  steps.push({ step: 'checked: b', at: 5, check: { command: 'b', result: 'failed' } })
  expect(card(steps)).toEqual([
    { row: 'setting up', spinning: false },
    { row: 'checked: a', spinning: false },
    { row: 'checked: b', spinning: false },
  ])
  // The next ordinary step is the one in progress.
  steps.push({ step: 'fast-forwarding', at: 6 })
  expect(card(steps).at(-1)).toEqual({ row: 'fast-forwarding', spinning: true })
})
