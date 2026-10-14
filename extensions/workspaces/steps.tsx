import type { LanderStep } from './types.ts'

/** A running check's line gives way to its result, which follows it. */
export const runningStep = /^(?:checking|rerunning): (.*)$/s
export const superseded = (row: LanderStep, later: readonly LanderStep[]) => {
  const command = runningStep.exec(row.step)?.[1]
  return command !== undefined && later.some((next) => next.check?.command === command)
}

/** A group's checks run together: a running check whose later rows all belong to its group still runs. */
const pending = (row: LanderStep, later: readonly LanderStep[]) =>
  runningStep.test(row.step) &&
  later.every((next) => next.check !== undefined || runningStep.test(next.step))

/** While its submission lands, a step is in progress when it is the last one or a group check still running; a check result never is. */
export const inProgress = (row: LanderStep, later: readonly LanderStep[]) =>
  !row.check && (!later.length || pending(row, later))
