/**
 * Computer use: the contracts shared by the Driver client, the policy, the Jev loop and the tools. Plain data only, so
 * every piece can be tested against fakes.
 */
import type { JsonValue } from '@earendil-works/chord'

/** One MCP tool result from Cua Driver, flattened. `refusal` is the Driver's structured refusal, when it gave one. */
export type DriverResult = {
  ok: boolean
  text: string
  structured: Record<string, JsonValue> | undefined
  images: { data: string; mimeType: string }[]
  refusal?: { code: string; message: string; hint?: string }
}

/** A live connection to one Driver. `call` sends one tool call; `stop` runs `cua-driver stop` (kills the daemon). */
export type Driver = {
  readonly version: string
  call(tool: string, args: Record<string, JsonValue>, signal?: AbortSignal): Promise<DriverResult>
  stop(): Promise<void>
  close(): Promise<void>
}

/** One accessibility element of a window snapshot, from the Driver's structured `elements`. */
export type Element = {
  token: string
  index: number
  parent?: number
  depth: number
  role: string
  label?: string
  value?: string
  enabled: boolean
  actions: string[]
  frame?: { x: number; y: number; w: number; h: number }
}

/** One observed window: identity, its elements and, when captured, the screenshot and its capture id. */
export type Observation = {
  app: string
  pid: number
  windowId: number
  title: string
  snapshot: string
  elements: Element[]
  /** The Driver's compact Markdown tree, for the model. */
  tree: string
  truncated: boolean
  capture?: { id: string; width: number; height: number; scale: number }
  image?: { data: string; mimeType: string }
}

/** One explicit step, addressed by element token or by pixel with the capture it came from. */
export type Step =
  | {
      kind: 'click' | 'double_click' | 'right_click'
      element?: string
      x?: number
      y?: number
      capture?: string
    }
  | { kind: 'type'; element: string; text: string }
  | { kind: 'set_value'; element: string; value: string }
  | { kind: 'key'; key: string; modifiers?: string[] }
  | {
      kind: 'scroll'
      element?: string
      direction: 'up' | 'down' | 'left' | 'right'
      amount?: number
    }
  | { kind: 'menu'; path: string[] }
  | { kind: 'wait'; seconds: number }

/** What happened to one step. `unknown` only after an interruption or a timeout mid-step. */
export type StepOutcome =
  | { status: 'delivered'; text: string }
  | { status: 'refused'; code: string; message: string }
  | { status: 'failed'; message: string }
  | { status: 'not_run' }
  | { status: 'unknown' }

/** A Driver `verify_state` predicate, passed through as given. */
export type Predicate = Record<string, JsonValue>
export type Verdict = 'satisfied' | 'unsatisfied' | 'unknown'

/** The planner's routine sub-goal for Jev goal mode. */
export type Goal = {
  text: string
  params?: Record<string, string>
  steps?: string[]
  done_when?: Predicate[]
  budget?: { steps?: number; seconds?: number }
}

/** Why goal mode handed back to the planner. */
export type Escalation =
  | 'no_candidates'
  | 'low_confidence'
  | 'consequential'
  | 'no_effect'
  | 'refused'
  | 'budget'
  | 'unverified_done'
  | 'unverifiable_done'
  | 'jev_unavailable'
  | 'stopped'

/** One Jev decision as journalled: the candidates' probabilities, the pick and what came of it. */
export type JevDecision = {
  step: number
  candidates: number
  top: { id: string; label: string; p: number }[]
  done: number
  risk: number
  chose: string | undefined
  outcome: 'acted' | 'verified' | 'no_effect' | 'escalated' | 'reobserved' | 'done'
}

export type GoalResult =
  | { status: 'done'; steps: number; decisions: JevDecision[]; verdict: Verdict }
  | {
      status: 'escalated'
      reason: Escalation
      detail: string
      steps: number
      decisions: JevDecision[]
      observation: Observation | undefined
    }

/** Initial goal-mode thresholds (decision 5a); settings `computerUse.jev.*` may override them. */
export const jevThresholds = { act: 0.8, margin: 0.25, done: 0.85, risk: 0.3, maxCandidates: 24 }
