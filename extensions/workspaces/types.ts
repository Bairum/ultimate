export type Workspace = {
  path: string
  branch: string
  base: string
  source: string
  target: string
  state: 'preparing' | 'ready' | 'failed' | 'removed'
  error?: string
  landed?: string
}
/** One `workspace submit`, waiting for or being processed by its source's lander. */
export type QueueEntry = {
  id: string
  conversationId: number
  source: string
  target: string
  tip: string
  at: number
  state: 'queued' | 'landing'
  step?: string
  /** What the lander did so far, as its conversation logs it. */
  steps: LanderStep[]
  /** What its fast-forward landed: recorded with it, so any later lander task pushes and reports that. */
  landed?: Landed
}
/** A submission's landing: the target moved from `base` to `sha`, which brought `commits` and `paths`. */
export type Landed = {
  sha: string
  base: string
  commits: string[]
  paths: string[]
  flaky: string[]
}
/** One row of a submission's progress: a step, or a check with its result. */
export type LanderStep = {
  step: string
  at: number
  check?: { command: string; result: 'passed' | 'failed' | 'flaky' }
}
/** How a submission ended. A push that failed after landing locally is `landed` with a `reason`. */
export type LanderOutcome = {
  outcome: 'landed' | 'failed'
  sha?: string
  commits?: string[]
  paths?: string[]
  flaky?: string[]
  /** `<remote>/<target>` it was pushed to. */
  pushed?: string
  needsRestart?: boolean
  reason?: string
  /** Output tail behind the reason: conflicting paths, a check's output, git's error. */
  output?: string
  /** What the submitter does next, for a failure. */
  hint?: string
}
/** One line of a lander conversation's log (entry kind `ultimate.lander`): a step, a check result, or the outcome. */
export type LanderEntry = {
  submission: string
  conversationId: number
  tip: string
  target: string
  at: number
  step?: string
  check?: { command: string; result: 'passed' | 'failed' | 'flaky' }
} & Partial<LanderOutcome>
export type WorkspaceIndex = {
  items: Record<string, Workspace>
  queue: QueueEntry[]
  /** Live lander task per source checkout. */
  landers: Record<string, number>
  /** The lander conversation per source checkout, where its task runs and logs. */
  landerConversations: Record<string, number>
  /** Outcomes of the latest submissions by id, with their target and lander conversation, for the submitter's cards. */
  results: Record<
    string,
    LanderOutcome & { target: string; tip: string; lander: number; steps: LanderStep[] }
  >
}
export type WorkspaceInfo = Workspace & {
  ahead: number | null
  tip: string | null
  sourceTip: string | null
  currentBranch: string | null
  sourceBranch: string | null
}
export type LandResult = {
  text: string
  landed?: string
  commits?: string[]
  paths?: string[]
  needsRestart?: boolean
}
export type SubmitResult = { text: string; id: string; position: number; lander: number }
