/**
 * Transcript cards of the computer tools: what the agent looked at (observe), what it did to which window and how
 * each step came out (act, explicit or Jev goal mode), and the launches (apps). A request raised by a call renders
 * under it, so the user answers where they read why.
 */
import { CircleStopIcon, LoaderCircleIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolImage,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { api, cn, errorMessage, useDocOf, useToolDuration, useTranscript } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { Answered, Requests, Takeover } from './requests.tsx'
import { SessionDoc, StopAction } from './refs.ts'
import {
  AnchorLine,
  escalations,
  headerState,
  liveSteps,
  Mark,
  parseResult,
  refusalText,
  predicate,
  toneClass,
  toneOf,
  useSession,
} from './shared.tsx'
import type { Journal, Outcome, Session, Tone, Window } from './shared.tsx'

type Image = ToolCallView['images'][number]
type Step = Record<string, unknown> & { kind?: string }

const text = (value: unknown) => (typeof value === 'string' ? value : '')
/** A string or number argument as text; anything else (a partial streaming value) as nothing. */
const scalar = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
/** Refusals that wait on the user: amber, and the request card below says the rest. */
const asks = ['consent_required', 'confirm_required', 'user_active']

/** `click 7`, `type 5 chars`, `key ⌘S`, `menu File › Save`: one step, as the user reads it. */
function describe(step: Step, target?: Journal) {
  const label = target?.label || (target?.role ? target.role.replace(/^AX/, '') : undefined)
  const element = label ? `“${label}”` : text(step.element) ? `element ${text(step.element)}` : ''
  switch (step.kind) {
    case 'type':
      return `${element} ← ${plural(text(step.text).length, 'char')}`
    case 'set_value':
      return `${element} = ${plural(text(step.value).length, 'char')}`
    case 'key': {
      const modifiers = Array.isArray(step.modifiers) ? step.modifiers.map(String) : []
      return [...modifiers, text(step.key)].join('+')
    }
    case 'menu':
      return (Array.isArray(step.path) ? step.path.map(String) : []).join(' › ')
    case 'scroll':
      return `${element || 'window'} ${text(step.direction)} ${scalar(step.amount) || '3'}`
    case 'wait':
      return `${scalar(step.seconds)}s`
    default:
      return element || (typeof step.x === 'number' ? `at ${step.x},${scalar(step.y)}` : '')
  }
}

/** Results of earlier and later observes of the same app in this transcript: the before and after pictures. */
function useShots(call: ToolCallView, app: string) {
  const entries = useTranscript()
  return useMemo(() => {
    const results = entries.flatMap((entry: EntryRecord) => {
      const message = entry.model?.[0]
      return entry.kind === 'pi.tool-result' && message?.role === 'toolResult' ? [message] : []
    })
    const index = results.findIndex((message) => message.toolCallId === call.id)
    if (index < 0) return {}
    const imageOf = (message: (typeof results)[number]) =>
      message.toolName === 'computer_observe' &&
      message.content.some(
        (block) => block.type === 'text' && block.text.includes(`"app":"${app}"`),
      )
        ? message.content.find((block) => block.type === 'image')
        : undefined
    const before = results.slice(0, index).findLast((message) => imageOf(message))
    const after = results.slice(index + 1).find((message) => imageOf(message))
    return {
      before: before && imageOf(before),
      after: after && imageOf(after),
    }
  }, [entries, call.id, app])
}

function Shots({ before, after }: { before?: Image; after?: Image }) {
  if (!before && !after) return null
  return (
    <ToolSection className="flex flex-wrap gap-3">
      {[
        ['before', before],
        ['after', after],
      ].map(([label, image]) =>
        image ? (
          <figure className="space-y-1" key={label as string}>
            <ToolImage
              alt={`${label as string} this call`}
              className="max-w-56"
              image={image as Image}
            />
            <figcaption className="text-[10.5px] text-muted-foreground/80">
              {label as string}
            </figcaption>
          </figure>
        ) : null,
      )}
    </ToolSection>
  )
}

/** The observed window: thumbnail, title, capture and a folded accessibility tree. */
function WindowView({ window, image }: { window: Window; image?: Image }) {
  const lines = window.tree?.split('\n').filter(Boolean) ?? []
  return (
    <>
      <ToolSection className="flex gap-3">
        {image && <ToolImage alt={window.title ?? 'Window'} className="shrink-0" image={image} />}
        <div className="flex min-w-0 flex-col gap-0.5 text-[11.5px]">
          <span className="truncate text-foreground/90" title={window.title}>
            {window.title ? `“${window.title}”` : 'untitled window'}
          </span>
          <span className="text-muted-foreground/80">
            {window.app}
            {window.capture && ` · ${window.capture.width}×${window.capture.height}`}
            {!image && ' · tree only'}
          </span>
        </div>
      </ToolSection>
      {lines.length > 0 && (
        <Collapsible className="group/tree border-t border-border/60">
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
            <span className="transition-transform group-data-[state=open]/tree:rotate-90">›</span>
            Accessibility tree · {plural(lines.length, 'line')}
            {window.truncated && <span className="text-warning">truncated</span>}
            <span className="ml-auto text-muted-foreground/60">screen text, untrusted</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mx-2.5 mb-2 max-h-72 overflow-auto rounded-sm bg-terminal px-2.5 py-2 text-[11px] leading-[1.5] whitespace-pre text-foreground/80">
              {window.tree}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  )
}

/** Stop beside a running call's header: blocks the next step at once. */
function StopButton({ conversation }: { conversation?: number }) {
  const [busy, setBusy] = useState(false)
  if (conversation === undefined) return null
  return (
    <button
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-error hover:bg-error/10"
      data-computer-stop
      disabled={busy}
      onClick={() => {
        setBusy(true)
        // Stop is project-wide: the server sets the flag on conversation 1 and interrupts every active call.
        api
          .action(StopAction, { conversation })
          .catch((error: unknown) => console.error(errorMessage(error)))
          .finally(() => setBusy(false))
      }}
      title="Stop computer use in this project: no further step is sent"
      type="button"
    >
      {busy ? (
        <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />
      ) : (
        <CircleStopIcon className="size-3" />
      )}
      Stop
    </button>
  )
}

/** A refusal or failure as one line: what it means in words, the code for reference. */
function Problem({ code, message }: { code: string; message?: string }) {
  const waits = asks.includes(code)
  const tone = waits || ['unknown', 'observe_first', 'checkpoint_due'].includes(code)
  return (
    <ToolSection>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className={tone ? 'text-warning' : 'text-error'}>{refusalText(code)}</span>
        <span className="text-muted-foreground/60">{code}</span>
      </div>
      {message && !waits && <p className="break-words text-muted-foreground">{message}</p>}
    </ToolSection>
  )
}

/**
 * The request this call raised, while it waits; once answered, what the user decided. A request belongs to the call
 * whose run recorded it, so an older card never repeats a newer request.
 */
function Raised({
  call,
  status,
  app,
  session,
  conversation,
}: {
  call: ToolCallView
  status?: string
  app: string
  session?: Session
  conversation?: number
}) {
  const project = useDocOf(1, SessionDoc)
  if (!session || conversation === undefined || !status) return null
  const from = call.startedAt ?? 0
  const until = (call.endedAt ?? Date.now()) + 1000
  const mine = (request: Session['pending'][number]) =>
    request.at >= from &&
    request.at <= until &&
    (request.kind === 'consent' || request.kind === 'confirm')
  if (status === 'user_active') {
    const granted = session.takeovers.some((t) => t.app.toLowerCase() === app.toLowerCase())
    return (
      <ToolSection>
        <Takeover app={app} conversation={conversation} granted={granted} />
      </ToolSection>
    )
  }
  if (session.pending.some(mine))
    return (
      <ToolSection>
        <Requests conversation={conversation} only={mine} session={session} />
      </ToolSection>
    )
  if (status === 'consent_required' || status === 'denied')
    return (
      <ToolSection>
        <Answered
          app={app}
          grants={[
            ...(project?.grants.filter((g) => g.scope === 'project') ?? []),
            ...session.grants,
            ...(project?.grants.filter((g) => g.scope === 'deny' && g.denyScope === 'project') ??
              []),
          ]}
        />
      </ToolSection>
    )
  return null
}

/** Status for a header meta: delivered quietly, everything else coloured and in words. */
function Verdict({ status }: { status?: string }) {
  if (!status) return null
  const tone = toneOf(status)
  return <span className={toneClass[tone]}>{tone === 'good' ? status : refusalText(status)}</span>
}

export function Observe({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const parsed = parseResult(call)
  const app = text(call.args.app)
  const listing = call.args.window === undefined
  const structured = (parsed.summary.structured ?? {}) as Record<string, unknown>
  const items = (
    Array.isArray(structured.apps)
      ? structured.apps
      : Array.isArray(structured.windows)
        ? structured.windows
        : []
  ) as Record<string, unknown>[]
  const failed = parsed.status && !['ok'].includes(parsed.status) && !parsed.window && !listing
  return (
    <Tool>
      <ToolHeader
        meta={
          <>
            {failed && <Verdict status={parsed.status} />}
            {call.args.zoom !== undefined && <span>zoom</span>}
            {call.args.evidence === true && <span className="text-brand">evidence</span>}
            {listing && items.length > 0 && (
              <span>{plural(items.length, app ? 'window' : 'app')}</span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name="observe"
        state={headerState(call.status, failed ? toneOf(parsed.status) : 'good')}
        title={
          listing
            ? app
              ? `${app} · windows`
              : 'running apps'
            : `${app}${parsed.window?.title ? ` · “${parsed.window.title}”` : call.args.window !== undefined ? ` · ${scalar(call.args.window)}` : ''}`
        }
      />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">reading the window…</Shimmer>
          </ToolSection>
        )}
        {parsed.window && <WindowView image={call.images[0]} window={parsed.window} />}
        {listing && items.length > 0 && (
          <ToolSection>
            <ul className="columns-2 gap-4 text-[11.5px] leading-[1.7] max-sm:columns-1">
              {items.map((item, index) => (
                <li className="truncate text-muted-foreground" key={index}>
                  <span className="text-foreground/90">
                    {text(item.name) || text(item.title) || text(item.window_title) || '(untitled)'}
                  </span>
                  {item.window_id !== undefined && ` · ${scalar(item.window_id)}`}
                </li>
              ))}
            </ul>
          </ToolSection>
        )}
        {failed && <Problem code={parsed.status!} message={parsed.message} />}
        {parsed.status === 'setup' && typeof parsed.summary.install === 'string' && (
          <ToolOutput output={parsed.summary.install} />
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      <AnchorLine anchor={parsed.anchor} />
    </Tool>
  )
}

type StepOutcome = { status: Outcome; code?: string; message?: string; text?: string }
type Decision = {
  step: number
  candidates: number
  top: { id: string; label: string; p: number }[]
  done: number
  risk: number
  chose?: string
  outcome: string
}

/** Pair each step with its journal entry (role and label of the control it hit), in dispatch order. */
function targets(steps: Step[], journal: Journal[]) {
  const queue = [...journal]
  return steps.map((step) => {
    const at = queue.findIndex((entry) => entry.kind === step.kind)
    return at < 0 ? undefined : queue.splice(0, at + 1).at(-1)
  })
}

function Steps({
  call,
  steps,
  outcomes,
  journal,
}: {
  call: ToolCallView
  steps: Step[]
  outcomes: StepOutcome[]
  journal: Journal[]
}) {
  const live = liveSteps(call.output)
  const hit = targets(steps, journal)
  return (
    <ToolSection label="Steps">
      {steps.map((step, index) => {
        const outcome = outcomes[index]
        const state: Outcome = outcome
          ? outcome.status
          : call.status === 'running'
            ? ((live.get(index + 1) === 'sending' ? 'running' : (live.get(index + 1) as Outcome)) ??
              'not_run')
            : 'not_run'
        return (
          <div
            className="flex min-w-0 items-start gap-2 leading-[1.7]"
            data-computer-step={state}
            key={index}
          >
            <Mark outcome={outcome?.code && asks.includes(outcome.code) ? 'waiting' : state} />
            <span className="w-16 shrink-0 text-foreground/90">
              {(step.kind ?? '?').replace('_', ' ')}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-muted-foreground"
                title={describe(step, hit[index])}
              >
                {describe(step, hit[index])}
              </span>
              {(state === 'refused' || state === 'failed') && (
                <span
                  className={cn(
                    'block break-words',
                    outcome?.code && asks.includes(outcome.code) ? 'text-warning' : 'text-error',
                  )}
                >
                  {outcome?.code ? refusalText(outcome.code) : ''}
                  {outcome?.message && !(outcome.code && asks.includes(outcome.code))
                    ? `${outcome.code ? ' · ' : ''}${outcome.message}`
                    : ''}
                </span>
              )}
              {state === 'unknown' && (
                <span className="block text-warning">
                  May or may not have happened: observe before going on
                </span>
              )}
            </span>
          </div>
        )
      })}
    </ToolSection>
  )
}

function Expect({ predicates, verdict }: { predicates: unknown[]; verdict?: string }) {
  if (!predicates.length) return null
  return (
    <ToolSection label="Expect">
      <div className="flex min-w-0 items-start gap-2">
        <Mark
          outcome={
            verdict === 'satisfied' ? 'delivered' : verdict === 'unsatisfied' ? 'failed' : 'unknown'
          }
        />
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          title={JSON.stringify(predicates)}
        >
          {predicates.map(predicate).join(' · ')}
        </span>
        <span className={verdict === 'satisfied' ? 'text-success' : 'text-warning'}>
          {verdict ?? 'unknown'}
        </span>
      </div>
    </ToolSection>
  )
}

const decisionTone: Record<string, string> = {
  verified: 'text-success',
  done: 'text-success',
  acted: 'text-foreground/80',
  reobserved: 'text-muted-foreground',
  no_effect: 'text-warning',
  escalated: 'text-warning',
}

/** Jev's decisions: what it picked, how sure it was, whether it worked. Alternatives on hover. */
function Decisions({ decisions }: { decisions: Decision[] }) {
  if (!decisions.length) return null
  return (
    <ToolSection label="Jev decisions">
      {decisions.map((decision, index) => {
        const pick = decision.top.find((t) => t.id === decision.chose) ?? decision.top[0]
        const alternatives = decision.top
          .filter((t) => t !== pick)
          .map((t) => `${t.label} ${Math.round(t.p * 100)}%`)
          .join(', ')
        return (
          <div className="flex min-w-0 items-baseline gap-2 leading-[1.7]" key={index}>
            <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
              {decision.step + 1}
            </span>
            <span
              className="min-w-0 flex-1 truncate"
              title={
                alternatives
                  ? `Also: ${alternatives} · of ${decision.candidates}`
                  : `of ${decision.candidates}`
              }
            >
              {decision.chose ? (
                <>
                  <span className="text-foreground/90">“{pick?.label ?? decision.chose}”</span>
                  {pick && (
                    <span className="text-muted-foreground"> {Math.round(pick.p * 100)}%</span>
                  )}
                </>
              ) : decision.outcome === 'done' ? (
                <span className="text-muted-foreground">
                  looks done {Math.round(decision.done * 100)}%
                </span>
              ) : (
                <span className="text-muted-foreground">no confident pick</span>
              )}
              {decision.risk >= 0.3 && (
                <span className="text-warning"> · risk {Math.round(decision.risk * 100)}%</span>
              )}
            </span>
            <span
              className={cn('shrink-0', decisionTone[decision.outcome] ?? 'text-muted-foreground')}
            >
              {decision.outcome.replace('_', ' ')}
            </span>
          </div>
        )
      })}
    </ToolSection>
  )
}

export function Act({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { id, session } = useSession()
  const parsed = parseResult(call)
  const app = text(call.args.app)
  const goal = call.args.goal as
    | { text?: string; params?: Record<string, string>; done_when?: unknown[] }
    | undefined
  const steps = (Array.isArray(call.args.actions) ? call.args.actions : []) as Step[]
  const outcomes = (
    Array.isArray(parsed.summary.outcomes) ? parsed.summary.outcomes : []
  ) as StepOutcome[]
  const decisions = (
    Array.isArray(parsed.summary.decisions) ? parsed.summary.decisions : []
  ) as Decision[]
  const journal = session?.journal.filter((entry) => entry.call === call.id) ?? []
  // While running, decisions arrive through the journal before the result has them.
  const shownDecisions = decisions.length
    ? decisions
    : journal.flatMap((entry) => (entry.decision ? [entry.decision as Decision] : []))
  const shots = useShots(call, app)
  const delivered = outcomes.filter((o) => o.status === 'delivered').length
  const status = parsed.status
  const reason = typeof parsed.summary.reason === 'string' ? parsed.summary.reason : undefined
  const window = parsed.window
  const background = call.args.foreground !== true
  const refusedBeforeStart = status && !outcomes.length && !goal ? status : undefined
  const waiting = outcomes.find((o) => o.code && asks.includes(o.code))?.code
  const expected = Array.isArray(call.args.expect) && call.args.expect.length > 0
  const verified = !expected || text(parsed.summary.verdict) === 'satisfied'
  // One tone for the whole call: the header icon and the summary on the right agree.
  const tone: Tone = goal
    ? status === 'done'
      ? 'good'
      : status === 'escalated'
        ? 'wait'
        : toneOf(status)
    : outcomes.length
      ? outcomes.some((o) => o.status === 'refused' || o.status === 'failed') && !waiting
        ? 'bad'
        : waiting || outcomes.some((o) => o.status !== 'delivered') || !verified
          ? 'wait'
          : 'good'
      : toneOf(status)
  return (
    <Tool defaultOpen>
      <ToolHeader
        action={call.status === 'running' ? <StopButton conversation={id} /> : undefined}
        meta={
          <>
            {goal ? (
              status === 'escalated' ? (
                <span className="text-warning">escalated</span>
              ) : (
                <Verdict status={status} />
              )
            ) : waiting ? (
              <span className="text-warning">{refusalText(waiting)}</span>
            ) : outcomes.some((o) => o.status === 'unknown') ? (
              <span className="text-warning">outcome unknown</span>
            ) : outcomes.length ? (
              <span className={tone === 'good' ? 'text-success' : toneClass[tone]}>
                {delivered}/{steps.length} delivered
              </span>
            ) : (
              <Verdict status={status} />
            )}
            {!background && <span className="text-warning">foreground</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name={goal ? 'act · goal' : 'act'}
        state={headerState(call.status, tone)}
        title={
          goal
            ? `${app} · ${text(goal.text)}`
            : `${app}${window?.title ? ` · “${window.title}”` : ''}`
        }
      />
      <ToolContent>
        {goal?.params && Object.keys(goal.params).length > 0 && (
          <ToolSection className="text-muted-foreground">
            {Object.entries(goal.params)
              .map(([key, value]) => `${key} = ${value}`)
              .join(' · ')}
          </ToolSection>
        )}
        {!goal && steps.length > 0 && !refusedBeforeStart && (
          <Steps call={call} journal={journal} outcomes={outcomes} steps={steps} />
        )}
        {goal && <Decisions decisions={shownDecisions} />}
        {goal && status === 'escalated' && reason && (
          <ToolSection>
            <p className="text-warning">{escalations[reason] ?? reason}</p>
            {typeof parsed.summary.detail === 'string' && parsed.summary.detail && (
              <p className="break-words text-muted-foreground">{parsed.summary.detail}</p>
            )}
            <p className="text-muted-foreground/70">
              Handed back to the agent to act explicitly or narrow the goal.
            </p>
          </ToolSection>
        )}
        {refusedBeforeStart && <Problem code={refusedBeforeStart} message={parsed.message} />}
        {!goal && delivered > 0 && (
          <Expect
            predicates={Array.isArray(call.args.expect) ? call.args.expect : []}
            verdict={text(parsed.summary.verdict) || undefined}
          />
        )}
        {goal?.done_when && goal.done_when.length > 0 && call.status !== 'running' && (
          <Expect
            predicates={goal.done_when}
            verdict={status === 'done' ? text(parsed.summary.verdict) || 'satisfied' : 'unknown'}
          />
        )}
        {call.status === 'running' && !steps.length && !shownDecisions.length && (
          <ToolSection>
            <Shimmer className="text-[12px]">working…</Shimmer>
          </ToolSection>
        )}
        <Shots after={call.images[0] ?? shots.after} before={shots.before} />
        <Raised
          app={app}
          call={call}
          conversation={id}
          session={session}
          status={refusedBeforeStart ?? outcomes.find((o) => o.code)?.code}
        />
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      <AnchorLine anchor={parsed.anchor} noTask={parsed.noTask} />
    </Tool>
  )
}

export function Apps({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { id, session } = useSession()
  const parsed = parseResult(call)
  const launch = text(call.args.launch)
  const structured = (parsed.summary.structured ?? {}) as Record<string, unknown>
  const apps = (Array.isArray(structured.apps) ? structured.apps : []) as Record<string, unknown>[]
  const ok = parsed.summary.ok === true
  const status = ok ? 'delivered' : parsed.status
  return (
    <Tool>
      <ToolHeader
        meta={
          <>
            {launch ? (
              <Verdict status={status} />
            ) : (
              apps.length > 0 && <span>{plural(apps.length, 'app')}</span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name={launch ? 'launch' : 'apps'}
        state={headerState(call.status, launch ? toneOf(status) : 'good')}
        title={launch || 'running apps'}
      />
      <ToolContent>
        {apps.length > 0 && (
          <ToolSection>
            <ul className="columns-2 gap-4 text-[11.5px] leading-[1.7] max-sm:columns-1">
              {apps.map((app, index) => (
                <li className="truncate text-foreground/90" key={index}>
                  {text(app.name)}
                </li>
              ))}
            </ul>
          </ToolSection>
        )}
        {launch && status && status !== 'delivered' && (
          <Problem code={status} message={parsed.message} />
        )}
        {launch && (
          <Raised app={launch} call={call} conversation={id} session={session} status={status} />
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      <AnchorLine anchor={parsed.anchor} />
    </Tool>
  )
}

/** One line for a folded run of work. */
export function Line({ call }: { call: ToolCallView }): ReactNode {
  const app = text(call.args.app) || text(call.args.launch)
  if (call.name === 'computer_observe') return `observe ${app || 'apps'}`
  if (call.name === 'computer_apps') return app ? `launch ${app}` : 'list apps'
  if (call.name === 'computer_task') return `task ${text(call.args.action)}`
  const goal = call.args.goal as { text?: string } | undefined
  return goal
    ? `act ${app} · ${text(goal.text)}`
    : `act ${app} · ${plural(Array.isArray(call.args.actions) ? call.args.actions.length : 0, 'step')}`
}
