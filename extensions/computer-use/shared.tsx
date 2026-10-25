/**
 * What the computer-use cards share: a result's structured `details` (`ComputerDetails`), the words for refusal codes
 * and escalations, and the small marks every card uses.
 */
import type { ReactNode } from 'react'
import { cn, useConversation, useDoc, useTranscript } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { SessionDoc } from './refs.ts'
import type { ComputerDetails, Session } from './refs.ts'

export type { ComputerDetails, Session }
export type Pending = Session['pending'][number]
export type Journal = Session['journal'][number]
export type TaskDetails = NonNullable<ComputerDetails['task']>

/** A finished call's card data; `undefined` while it runs or for a result without details. */
export const detailsOf = (call: ToolCallView) =>
  call.result ? (call.details as ComputerDetails | undefined) : undefined

/**
 * A result's summary (task and apps results) as a plain object. It is untrusted data: cards read known fields from it
 * and render their strings as plain text only.
 */
export const summaryOf = (details?: ComputerDetails): Record<string, unknown> => {
  const value = details?.summary?.value
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Refusals that wait on the user: amber, and the request card says the rest. */
export const asks = ['consent_required', 'confirm_required', 'user_active', 'takeover_required']
/** The code a call is waiting on the user for: its top-level status or a refused step's code. */
export const waitingOf = (details?: ComputerDetails) =>
  details?.act?.mode === 'goal' && details.act.escalationReason === 'consequential'
    ? 'confirm_required'
    : [details?.status, ...(details?.act?.steps.map((s) => s.code) ?? [])].find(
        (code): code is string => !!code && asks.includes(code),
      )

/**
 * Whether `call` is the newest card of its task that waits on the user: a request shows once, under the call that
 * raised it most recently, never repeated on older cards of the same task.
 */
export function useNewestWaiting(call: ToolCallView, task: string | undefined) {
  const entries = useTranscript()
  if (!task) return false
  const newest = entries.findLast((entry) => {
    const message = entry.model?.[0]
    if (entry.kind !== 'pi.tool-result' || message?.role !== 'toolResult') return false
    const details = message.details as ComputerDetails | undefined
    return details?.task?.id === task && !!waitingOf(details)
  })
  const message = newest?.model?.[0]
  return message?.role === 'toolResult' && message.toolCallId === call.id
}

/** Live progress while a call runs: `Step n: kind sending` then `Step n: status`. */
export function liveSteps(output: string) {
  const steps = new Map<number, string>()
  for (const line of output.split('\n')) {
    const match = /^Step (\d+): (?:\S+ )?(sending|delivered|refused|failed|unknown|not_run)$/.exec(
      line,
    )
    if (match) steps.set(Number(match[1]), match[2])
  }
  return steps
}

/** The words for a refusal code or status, as the user reads them. */
const refusals: Record<string, string> = {
  consent_required: 'needs your consent',
  denied: 'you denied this app',
  confirm_required: 'needs your confirmation',
  user_active: 'you are using this app',
  stopped: 'stopped',
  out_of_scope: 'outside the task scope',
  loop: 'repeating itself',
  checkpoint_due: 'checkpoint due',
  replan_required: 'off track: must replan',
  budget: 'budget used up',
  observe_first: 'must observe first',
  stale: 'element changed',
  stale_element_token: 'element changed',
  app_identity: 'app name mismatch',
  risk_unavailable: 'risk check failed',
  zoom_read_only: 'zoom is read-only',
  unsupported_step: 'unsupported step',
  invalid_arguments: 'invalid arguments',
  no_task: 'no task started',
  subgoal_required: 'no active sub-goal',
  criteria_unmet: 'criteria not met',
  busy: 'another computer call is running',
  setup: 'Cua Driver not set up',
  screen_locked: 'screen is locked',
  incomplete: 'incomplete',
  awaiting_confirmation: 'waits for you',
  unknown: 'outcome unknown',
  payload_too_large: 'too long to confirm',
  failed: 'failed',
  label_mismatch: 'label not confirmed',
  label_ambiguous: 'label appears more than once nearby',
  window_not_visible: 'window not visible',
  takeover_required: 'needs your foreground takeover',
  perception_unavailable: 'could not read the screen',
  capture_required: 'needs a screenshot',
  timeout: 'wait timed out',
  teaching: 'you are teaching: the agent only watches',
  teaching_elsewhere: 'another conversation is teaching in this app',
  scope_required: 'say whether the lesson is the project’s or yours',
  resave_required: 'lesson must be saved again first',
  consequential_not_taught: 'pre-approval names a step the lesson never taught',
  unsupported_until_secrets: 'lesson types a secret: not supported yet',
  practice_budget: 'lesson too long to practice',
  expect_required: 'a step has no expected result',
  intent_required: 'needs your request in your words',
  param_required: 'needs a value for the lesson',
  param_provenance: 'value did not come from you',
  review_required: 'reopened lesson not saved yet',
  practice_checks_required: 'not every step was checked',
  practice_mismatch: 'practice stopped at a mismatch',
  practice_task_changed: 'a different task is running',
  mismatch: 'screen did not match the lesson',
  no_practice: 'no practice run started',
  invalid_step: 'no such step in the lesson',
}
export const refusalText = (code: string) =>
  refusals[code] ?? (code.startsWith('task_') ? `task ${code.slice(5).replace('_', ' ')}` : code)

/** What the user can do about a refusal the agent cannot fix alone, in their words. */
export const fixes: Record<string, string> = {
  window_not_visible:
    'The window is off screen or shrunk to a Stage Manager thumbnail, so its pixels cannot be read. Turn Stage Manager off or bring the window to the front; the agent then observes again.',
  teaching:
    'This conversation is recording a lesson, so the agent may not act. Stop or finish the recording first.',
  teaching_elsewhere:
    'Another conversation is recording a lesson in this app or window. This agent cannot act there until that recording stops.',
  scope_required:
    'A lesson with this name exists in this project, in your personal skills, or both. Tell the agent which one to practice.',
  resave_required:
    'The saved lesson is from an older version or its files changed. Reopen it, approve the steps again and save.',
  consequential_not_taught:
    'Only labels of consequential steps the lesson actually taught can be pre-approved. The agent must ask again with the taught labels.',
  unsupported_until_secrets:
    'The lesson types a secret value. That needs the secrets support that is not built yet; it never types it as plain text.',
  practice_budget: 'Practice runs at most 100 steps. Split the lesson into shorter ones.',
  expect_required:
    'Reopen the lesson and add what should appear or go away after each step, then save again.',
  review_required: 'Finish reviewing the reopened lesson and save it before practicing.',
  practice_mismatch:
    'A step did not match its lesson, so this run cannot finish as done. Reopen the lesson to fix it, then practice again.',
}

/** The marker every piece of screen text carries: it is shown as plain text and never acted on. */
export function ScreenMark() {
  return (
    <span className="ml-1.5 text-[10.5px] text-muted-foreground/60">screen text, untrusted</span>
  )
}

/** Screen strings as `“a” · “b” · +3 more`, plain text with the marker. */
export function ScreenList({ items, max = 6 }: { items: readonly string[]; max?: number }) {
  const shown = items.slice(0, max)
  return (
    <>
      {shown.map((item) => `“${item}”`).join(' · ')}
      {items.length > max && (
        <span className="text-muted-foreground/60"> · +{items.length - max} more</span>
      )}
      <ScreenMark />
    </>
  )
}

/** Why Jev handed a goal back. */
export const escalations: Record<string, string> = {
  no_candidates: 'No matching control on screen',
  low_confidence: 'Not confident enough to pick',
  consequential: 'A risky step needs your confirmation',
  no_effect: 'The step had no visible effect',
  refused: 'A step was refused',
  budget: 'Out of goal steps or time',
  unverified_done: 'Looked done but did not verify',
  unverifiable_done: 'No check to verify done',
  jev_unavailable: 'Jev is unavailable',
  stopped: 'Stopped',
  payload_too_large: 'The text is too long to confirm',
}

/**
 * A step's outcome as one mark: delivered ✓, refused/failed ✗, unknown ?, not run ·, running ●, and `waiting` ‖ for
 * a step refused until the user answers (consent, confirmation, takeover).
 */
export type Outcome =
  | 'delivered'
  | 'refused'
  | 'failed'
  | 'unknown'
  | 'not_run'
  | 'running'
  | 'waiting'
  | 'timeout'
const marks: Record<Outcome, [string, string]> = {
  delivered: ['✓', 'text-success'],
  refused: ['✗', 'text-error'],
  failed: ['✗', 'text-error'],
  unknown: ['?', 'text-warning'],
  not_run: ['·', 'text-muted-foreground/50'],
  running: ['●', 'animate-pulse-dot text-brand'],
  waiting: ['‖', 'text-warning'],
  timeout: ['◷', 'text-warning'],
}
export function Mark({ outcome }: { outcome: Outcome }) {
  const [glyph, tone] = marks[outcome]
  return (
    <span aria-label={outcome.replace('_', ' ')} className={cn('w-3 shrink-0 text-center', tone)}>
      {glyph}
    </span>
  )
}

/** The session of the conversation a card renders in. */
export function useSession() {
  const id = useConversation((conversation) => conversation.id)
  return { id, session: useDoc(SessionDoc) ?? undefined }
}

/**
 * `task T1 · S2/3 · criteria 1/2 · steps 4/60`: how far the task was when this call returned. A finished call without
 * a task says so, since acting without one is refused.
 */
export function TaskLine({ details }: { details?: ComputerDetails }) {
  if (!details) return null
  const task = details.task
  if (!task)
    return (
      <Footer>
        <span className="text-warning">no active task</span>
      </Footer>
    )
  const nearBudget = task.steps.used >= task.steps.limit * 0.8
  return (
    <Footer>
      <span className="text-foreground/80">task {task.id}</span>
      {task.status !== 'active' && <span>{task.status.replaceAll('_', ' ')}</span>}
      <span title={task.subgoal?.text}>
        {task.subgoal?.id ?? '–'}/{task.subgoals}
      </span>
      <span className={task.criteria.met === task.criteria.total ? 'text-success' : undefined}>
        criteria {task.criteria.met}/{task.criteria.total}
      </span>
      <span className={nearBudget ? 'text-warning' : undefined}>
        steps {task.steps.used}/{task.steps.limit}
      </span>
      {task.lastCheck && (
        <span className="min-w-0 truncate" title={task.lastCheck}>
          check: {task.lastCheck}
        </span>
      )}
    </Footer>
  )
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 border-t border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground [&>*+*]:before:mr-2 [&>*+*]:before:text-muted-foreground/50 [&>*+*]:before:content-['·']">
      {children}
    </div>
  )
}

/** Text for a JSON value in a Driver predicate or Jev candidate: short, one line. */
export const short = (value: unknown, max = 80) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * A Driver `verify_state` predicate as the user reads it: `AXStaticText = "42"`, `"Save" enabled`. Unknown shapes
 * fall back to short JSON.
 */
export function predicate(value: unknown) {
  const p = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const element = (p.element && typeof p.element === 'object' ? p.element : undefined) as
    | Record<string, unknown>
    | undefined
  if (element) {
    const selector = (element.selector ?? {}) as Record<string, unknown>
    const who =
      typeof selector.label === 'string'
        ? `“${selector.label}”`
        : typeof selector.role === 'string'
          ? selector.role.replace(/^AX/, '')
          : 'element'
    for (const [key, words] of [
      ['value_equals', '='],
      ['value_contains', 'contains'],
      ['label_equals', 'label ='],
    ] as const)
      if (typeof element[key] === 'string') return `${who} ${words} “${element[key]}”`
    if (element.enabled === true) return `${who} enabled`
    if (element.exists === false) return `${who} gone`
    return `${who} exists`
  }
  if (typeof p.value === 'string') return `value = “${p.value}”`
  if (typeof p.window_title === 'string') return `window “${p.window_title}”`
  const ocr = (p.ocr && typeof p.ocr === 'object' ? p.ocr : undefined) as
    | Record<string, unknown>
    | undefined
  if (ocr) {
    const labels = (list: unknown, words: string) =>
      (Array.isArray(list) ? list : []).map((label) => `“${String(label)}” ${words}`)
    const parts = [...labels(ocr.appears, 'appears'), ...labels(ocr.disappears, 'gone')]
    return `OCR ${parts.join(' · ') || 'check'}`
  }
  return short(value, 60)
}

/** How a finished call went, for its header icon and summary: all good, waiting on someone, or failed. */
export type Tone = 'good' | 'wait' | 'bad'
export const toneClass: Record<Tone, string> = {
  good: 'text-success',
  wait: 'text-warning',
  bad: 'text-error',
}
export const toneOf = (status?: string): Tone =>
  !status ||
  ['ok', 'delivered', 'done', 'active', 'satisfied', 'completed', 'ready', 'review'].includes(
    status,
  )
    ? 'good'
    : ['escalated', 'unknown', 'incomplete', 'stopped', 'awaiting_confirmation'].includes(status) ||
        status.endsWith('_required') ||
        [
          'user_active',
          'observe_first',
          'checkpoint_due',
          'window_not_visible',
          'timeout',
          'teaching',
          'teaching_elsewhere',
        ].includes(status)
      ? 'wait'
      : 'bad'
/**
 * The header icon of a finished call follows its tone: a green check only when everything was delivered and verified,
 * an amber mark when it waits (on the user, an escalation, an unknown outcome), a red cross when a step failed.
 */
export const headerState = (status: ToolCallView['status'], tone: Tone): ToolCallView['status'] =>
  status !== 'done' ? status : tone === 'good' ? 'done' : tone === 'wait' ? 'interrupted' : 'error'
