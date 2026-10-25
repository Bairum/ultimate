/** Computer use: durable session state and the user's consent, confirmation and stop controls. */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { JevDecision, TaskState } from './types.ts'
import type { Grant } from './types.ts'
import type { JsonValue } from '@earendil-works/chord'
import type { Step, StepOutcome, Verdict } from './types.ts'
import type { PracticeCheck } from './types.ts'

export type Session = {
  task?: TaskState
  grants: Grant[]
  confirmed: { key: string; at: number; task: string }[]
  pending: {
    kind: 'consent' | 'confirm' | 'task' | 'change'
    app: string
    step?: number
    task?: string
    key?: string
    at: number
    window?: string
    label?: string
    payload?: string
    /** Screenshot pixels, present together for pixel-click confirmations. */
    x?: number
    y?: number
  }[]
  journal: {
    call: string
    step: number
    kind: string
    app: string
    role?: string
    label?: string
    length?: number
    status: 'sending' | 'delivered' | 'refused' | 'failed' | 'unknown' | 'decision'
    at: number
    decision?: Omit<JevDecision, 'chose'> & { chose?: string }
  }[]
  stopped: boolean
  lastObservedAt: number
  takeovers: { app: string; at: number }[]
  budget: { steps: number; startedAt: number }
}

/** Structured card data. Screen strings stay explicitly untrusted; payload values are redacted. */
export type UntrustedText = { text: string; untrusted: true }
export type ActStepDetails = {
  kind: Step['kind']
  status: StepOutcome['status']
  code?: string
  message?: string
  role?: UntrustedText
  label?: UntrustedText
  expectLabel?: UntrustedText
  ocrMatch?: UntrustedText
  /** For `label_mismatch` / `label_ambiguous`: the OCR labels nearest the click point. */
  nearest?: UntrustedText[]
  /** `ms`: how long the wait took. */
  wait?: { status: 'satisfied' | 'timeout'; ms: number; seen: UntrustedText[] }
}
export type JevDecisionDetails = Omit<JevDecision, 'chose' | 'top'> & {
  chose?: string
  top: { id: string; label: UntrustedText; p: number }[]
}
export type ComputerDetails = {
  task: {
    id: string
    status: TaskState['status']
    subgoal: { id: string; text: string } | null
    subgoals: number
    criteria: { met: number; total: number }
    steps: { used: number; limit: number }
    lastCheck?: string
    approval?: {
      app: UntrustedText
      appName?: UntrustedText
      window?: number | UntrustedText
      consequential: UntrustedText[]
      pixel: true
      actions: Step['kind'][]
      steps: number
      minutes: number
      foreground: boolean
      takeover: boolean
    }
  } | null
  status?: string
  message?: string
  summary?: { value: JsonValue; untrusted: true }
  teach?: {
    status: TeachStatus | 'practice' | 'mismatch'
    endedBy?: 'unavailable'
    frames: number
    dropped: Record<string, number>
    steps: {
      n: number
      action: string
      label: UntrustedText
      anchors: UntrustedText[]
      expect: { appears?: UntrustedText[]; disappears?: UntrustedText[]; timeoutSeconds?: number }
      wait?: { until: UntrustedText; timeoutSeconds: number }
      pitfalls?: UntrustedText[]
      approved?: boolean
      consequential: boolean
    }[]
    practice?: {
      task: string
      skill: string
      scope: 'project' | 'personal'
      status: 'ready' | 'mismatch'
      title: UntrustedText
      app: UntrustedText
      window: { id: number; titleSubstring: UntrustedText }
      checks: { step: number; phase: 'before' | 'after'; at: number; frame: FrameRef }[]
      final?: FrameRef
    }
    mismatches?: {
      step: number
      phase: 'before' | 'after'
      at: number
      expected: UntrustedText[]
      seen: UntrustedText[]
      taught: FrameRef
      fresh: FrameRef
    }[]
  }
  act?: {
    mode: 'explicit' | 'goal'
    steps: ActStepDetails[]
    escalationReason?: string
    decisions: JevDecisionDetails[]
    verdict?: Verdict
  }
  observe?: {
    app: string
    window: number
    title: UntrustedText
    snapshot: string
    capture?: { width: number; height: number; scale: number }
    truncated: boolean
    tree: UntrustedText
    imageIndex?: number
  }
}
/** Per-conversation state; conversation 1 also stores project grants. Journal keeps the latest 200 entries. */
export const SessionDoc = docRef<Session>('computer.session')
/** `{conversation, app, scope, always?}` → session; user-only consent. `always` is required for deny-listed apps. */
export const GrantAction = actionRef<
  {
    conversation: number
    app: string
    scope: 'once' | 'conversation' | 'project'
    always?: boolean
  },
  Session
>('computer-use', 'grant')
/** `{conversation, app, scope?}` → session; user-only revocation (conversation by default). */
export const DenyAction = actionRef<
  { conversation: number; app: string; scope?: 'conversation' | 'project' },
  Session
>('computer-use', 'deny')
/** `{conversation, key}` → session; user-only confirmation of an exact pending action. */
export const ConfirmAction = actionRef<{ conversation: number; key: string }, Session>(
  'computer-use',
  'confirm',
)
/** `{conversation}` → session; stop between steps, killing the daemon on a second stop or after 1 s in flight. */
export const StopAction = actionRef<{ conversation: number }, Session>('computer-use', 'stop')
/** `{}` → `{stopped:true}`; user-only immediate daemon kill (all sessions on this Mac). */
export const HardStopAction = actionRef<Record<string, never>, { stopped: true }>(
  'computer-use',
  'hardStop',
)
/** `{conversation}` → session; unblock and wake the conversation. */
export const ResumeAction = actionRef<{ conversation: number }, Session>('computer-use', 'resume')
/** `{conversation}` → session; read-only. */
export const StateAction = actionRef<{ conversation: number }, Session>('computer-use', 'state')
/** `{conversation, app}` → session; user-only foreground takeover until stop/release (later: task end). */
export const TakeoverAction = actionRef<{ conversation: number; app: string }, Session>(
  'computer-use',
  'takeover',
)
/** `{conversation, app}` → session; user-only foreground takeover revocation. */
export const ReleaseAction = actionRef<{ conversation: number; app: string }, Session>(
  'computer-use',
  'release',
)
/** `{conversation}` → session; user-only confirmation of the task's intent and scope. */
export const ConfirmTaskAction = actionRef<{ conversation: number }, Session>(
  'computer-use',
  'confirmTask',
)
/** `{conversation}` → session; user-only approval of criteria weakening or scope widening. */
export const ConfirmChangeAction = actionRef<{ conversation: number }, Session>(
  'computer-use',
  'confirmChange',
)

export type TeachStatus = 'recording' | 'paused' | 'drafting' | 'review' | 'saved' | 'rejected'
export type TaughtStep = {
  n: number
  action: 'click' | 'type' | 'type_secret' | 'key' | 'wait' | 'upload' | 'select'
  target: { label: string; anchors: string[]; region?: [number, number, number, number] }
  value?: { param: string }
  expect: { appears?: string[]; disappears?: string[]; timeoutSeconds?: number }
  wait?: { until: string; timeoutSeconds: number }
  pitfalls?: string[]
  frame: string
  approved?: boolean
  consequential?: boolean
}
export type FrameMeta = {
  id: string
  at: number
  file?: string
  width: number
  height: number
  ocr: {
    text: string
    bounds: { x: number; y: number; width: number; height: number }
    confidence: number
  }[]
  diff: { appeared: string[]; disappeared: string[]; region?: [number, number, number, number] }
  inferred: string
}
export type FrameRef = { id: string; width: number; height: number; file?: string }
export type TeachPractice = {
  task: string
  skill: string
  scope: 'project' | 'personal'
  status: 'ready' | 'mismatch'
  title: string
  app: string
  bundle: string
  window: { id: number; titleSubstring: string }
  steps: TaughtStep[]
  frames: Record<string, FrameRef>
  checks: PracticeCheck[]
  final?: PracticeCheck
}
export type TeachMismatch = {
  step: number
  phase: 'before' | 'after'
  at: number
  expected: string[]
  seen: string[]
  taught: FrameRef
  fresh: FrameMeta
}
export type Teach = {
  segment?: {
    id: string
    app: string
    bundle?: string
    onceGrantAt?: number
    window: number
    windowTitle?: string
    source?: { scope: 'project' | 'personal'; name: string; hash: string }
    title: string
    startedAt: number
    endsAt: number
    status: TeachStatus
    endedBy?: 'unavailable'
    frames: FrameMeta[]
    narration: { at: number; entry: number }[]
    dropped: { reason: string; at: number }[]
  }
  steps?: TaughtStep[]
  saved?: { path: string; at: number }
  practice?: TeachPractice
  mismatches?: TeachMismatch[]
}
/** Forks start fresh: recording consent and private frame files must not spread to children. */
export const TeachDoc = docRef<Teach>('computer.teach')
export type TeachStart = {
  conversation: number
  app: string
  window?: string | number
  minutes?: number
  title: string
}
/** TeachStart → teaching document; user-only observation authority. */
export const TeachStartAction = actionRef<TeachStart, Teach>('computer-use', 'teachStart')
/** {conversation} → teaching document in drafting; stops observation. */
export const TeachStopAction = actionRef<{ conversation: number }, Teach>(
  'computer-use',
  'teachStop',
)
/** {conversation} → teaching document paused; captures nothing. */
export const TeachPauseAction = actionRef<{ conversation: number }, Teach>(
  'computer-use',
  'teachPause',
)
/** {conversation} → teaching document recording; rechecks consent. */
export const TeachResumeAction = actionRef<{ conversation: number }, Teach>(
  'computer-use',
  'teachResume',
)
/** {conversation, steps} → teaching document; validated full replacement, no files. */
export const TeachEditAction = actionRef<{ conversation: number; steps: TaughtStep[] }, Teach>(
  'computer-use',
  'teachEdit',
)
/** {conversation, scope, name, overwrite?} → {path, notes}; saves reviewed files, noting missing evidence. */
export const TeachSaveAction = actionRef<
  { conversation: number; scope: 'project' | 'personal'; name: string; overwrite?: boolean },
  { path: string; notes: string[] }
>('computer-use', 'teachSave')
/** {conversation} → rejected teaching document; deletes segment frames. */
export const TeachRejectAction = actionRef<{ conversation: number }, Teach>(
  'computer-use',
  'teachReject',
)
/** {conversation, scope, name} → non-recording review; user and host only, all approvals cleared. */
export const TeachReopenAction = actionRef<
  { conversation: number; scope: 'project' | 'personal'; name: string },
  Teach
>('computer-use', 'teachReopen')
