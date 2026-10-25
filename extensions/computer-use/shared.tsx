/**
 * What the computer-use cards share: reading a tool result's content blocks, the words for refusal codes and
 * escalations, and the small marks every card uses.
 *
 * The server returns `structuredOutput` but no `details`, so a transcript card reads `result.content`: the JSON summary
 * first, then (observe/act) `metadata JSON\n<untrusted_screen_content>…`, and last the redacted task anchor.
 */
import type { ReactNode } from 'react'
import { cn, useConversation, useDoc } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { SessionDoc } from './refs.ts'
import type { Session } from './refs.ts'

export type { Session }
export type Pending = Session['pending'][number]
export type Journal = Session['journal'][number]

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const json = (text: string | undefined) => {
  if (!text) return undefined
  try {
    return record(JSON.parse(text))
  } catch {
    // Not JSON: a tree block or the anchor; the caller treats it as absent.
    return undefined
  }
}

/** The observed window's identity, from the `metadata JSON` line before the untrusted tree. */
export type Window = {
  app?: string
  title?: string
  windowId?: number
  snapshot?: string
  truncated?: boolean
  capture?: { id: string; width: number; height: number }
  tree?: string
}

/** The anchor every result ends with, split into what the card shows; `undefined` with no active task. */
export type Anchor = {
  task: string
  active: string
  subgoals: string
  activeText: string
  met: number
  criteria: number
  steps: number
  maxSteps: number
  check: string
}

export function parseAnchor(text: string | undefined): Anchor | undefined {
  const match =
    /^Task (.+?) · intent: ".*?" · (\S+)\/(\d+) active: "(.*?)" · criteria (\d+)\/(\d+) met · steps (\d+)\/(\d+) · scope: .*? · last check: (.*)$/s.exec(
      text ?? '',
    )
  if (!match) return undefined
  return {
    task: match[1],
    active: match[2],
    subgoals: match[3],
    activeText: match[4],
    met: Number(match[5]),
    criteria: Number(match[6]),
    steps: Number(match[7]),
    maxSteps: Number(match[8]),
    check: match[9],
  }
}

function parseWindow(text: string | undefined): Window | undefined {
  if (!text?.includes('<untrusted_screen_content>')) return undefined
  const [head, ...rest] = text.split('\n')
  const meta = json(head) ?? {}
  const tree = rest
    .join('\n')
    .replace(/^<untrusted_screen_content>\n?/, '')
    .replace(/\n?<\/untrusted_screen_content>$/, '')
  const capture = record(meta.capture)
  return {
    ...(typeof meta.app === 'string' ? { app: meta.app } : {}),
    ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
    ...(typeof meta.windowId === 'number' ? { windowId: meta.windowId } : {}),
    ...(typeof meta.snapshot === 'string' ? { snapshot: meta.snapshot } : {}),
    truncated: meta.truncated === true,
    ...(typeof capture.id === 'string'
      ? {
          capture: {
            id: capture.id,
            width: Number(capture.width),
            height: Number(capture.height),
          },
        }
      : {}),
    tree,
  }
}

/** A finished call's parts: its JSON summary, the window it shows, its images and the task anchor. */
export function parseResult(call: ToolCallView) {
  const texts = (call.result?.content ?? []).flatMap((block) =>
    block.type === 'text' ? [block.text] : [],
  )
  const anchorText = texts.find((text) => /^(Task |No active task)/.test(text))
  const window = texts.map(parseWindow).find(Boolean)
  const summary = json(texts.find((text) => text.startsWith('{') && !parseWindow(text)))
  return {
    summary: summary ?? {},
    status: typeof summary?.status === 'string' ? summary.status : undefined,
    message: typeof summary?.message === 'string' ? summary.message : undefined,
    window,
    anchor: parseAnchor(anchorText),
    noTask: anchorText?.startsWith('No active task') ?? false,
  }
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
  unknown: 'outcome unknown',
}
export const refusalText = (code: string) =>
  refusals[code] ?? (code.startsWith('task_') ? `task ${code.slice(5).replace('_', ' ')}` : code)

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
const marks: Record<Outcome, [string, string]> = {
  delivered: ['✓', 'text-success'],
  refused: ['✗', 'text-error'],
  failed: ['✗', 'text-error'],
  unknown: ['?', 'text-warning'],
  not_run: ['·', 'text-muted-foreground/50'],
  running: ['●', 'animate-pulse-dot text-brand'],
  waiting: ['‖', 'text-warning'],
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

/** `Task T1 · S2/3 · criteria 1/2 · steps 4/60`: how far the task was when this call returned. */
export function AnchorLine({ anchor, noTask }: { anchor?: Anchor; noTask?: boolean }) {
  if (!anchor)
    return noTask ? (
      <Footer>
        <span className="text-warning">no active task</span>
      </Footer>
    ) : null
  const nearBudget = anchor.steps >= anchor.maxSteps * 0.8
  return (
    <Footer>
      <span className="text-foreground/80">task {anchor.task}</span>
      <span title={anchor.activeText}>
        {anchor.active}/{anchor.subgoals}
      </span>
      <span className={anchor.met === anchor.criteria ? 'text-success' : undefined}>
        criteria {anchor.met}/{anchor.criteria}
      </span>
      <span className={nearBudget ? 'text-warning' : undefined}>
        steps {anchor.steps}/{anchor.maxSteps}
      </span>
      {anchor.check !== 'none' && (
        <span className="min-w-0 truncate" title={anchor.check}>
          check: {anchor.check}
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
  return short(value, 60)
}
