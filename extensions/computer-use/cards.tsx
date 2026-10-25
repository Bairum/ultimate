/**
 * Transcript cards of the computer tools: what the agent looked at (observe), what it did to which window and how
 * each step came out (act, explicit or Jev goal mode), and the launches (apps). Each reads the result's structured
 * `details` (`ComputerDetails`); a request raised by a call renders under it, so the user answers where they read why.
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
import type { ActStepDetails } from './refs.ts'
import {
  asks,
  detailsOf,
  escalations,
  headerState,
  liveSteps,
  Mark,
  refusalText,
  predicate,
  summaryOf,
  TaskLine,
  toneClass,
  toneOf,
  useNewestWaiting,
  useSession,
  waitingOf,
} from './shared.tsx'
import type { ComputerDetails, Outcome, Session, Tone } from './shared.tsx'

type Image = ToolCallView['images'][number]
type Step = Record<string, unknown> & { kind?: string }
type Observed = NonNullable<ComputerDetails['observe']>

const text = (value: unknown) => (typeof value === 'string' ? value : '')
/** A string or number argument as text; anything else (a partial streaming value) as nothing. */
const scalar = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * `“6”`, `“Email” ← 5 chars`, `⌘+S`, `File › Save`: one step as the user reads it. The control comes from the
 * step's details (redacted on the server); typed text only ever shows as its length.
 */
function describe(step: Step, done?: ActStepDetails) {
  // Labels and roles are screen text: shown verbatim, quoted, never interpreted.
  const label = done?.label?.text || done?.role?.text.replace(/^AX/, '') || undefined
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

/** The window image a result carries, by the content index its details name. */
function imageAt(call: ToolCallView, observe?: Observed): Image | undefined {
  const block =
    observe?.imageIndex === undefined ? undefined : call.result?.content[observe.imageIndex]
  return block?.type === 'image' ? block : undefined
}

/** The picture of the same app from the nearest earlier observe or act in this transcript: the before shot. */
function useBefore(call: ToolCallView, app: string) {
  const entries = useTranscript()
  return useMemo(() => {
    const results = entries.flatMap((entry: EntryRecord) => {
      const message = entry.model?.[0]
      return entry.kind === 'pi.tool-result' && message?.role === 'toolResult' ? [message] : []
    })
    const index = results.findIndex((message) => message.toolCallId === call.id)
    for (const message of results.slice(0, Math.max(0, index)).toReversed()) {
      const observe = (message.details as ComputerDetails | undefined)?.observe
      if (observe?.app !== app || observe.imageIndex === undefined) continue
      const block = message.content[observe.imageIndex]
      if (block?.type === 'image') return block
    }
    return undefined
  }, [entries, call.id, app])
}

function Shots({ before, after }: { before?: Image; after?: Image }) {
  if (!before && !after) return null
  return (
    <ToolSection className="flex flex-wrap gap-3">
      {(
        [
          ['before', before],
          ['after', after],
        ] as const
      ).map(([label, image]) =>
        image ? (
          <figure className="space-y-1" key={label}>
            <ToolImage alt={`${label} this call`} className="max-w-56" image={image} />
            <figcaption className="text-[10.5px] text-muted-foreground/80">{label}</figcaption>
          </figure>
        ) : null,
      )}
    </ToolSection>
  )
}

/**
 * The observed window: thumbnail, title, capture size and a folded accessibility tree. Title and tree are screen
 * text, marked untrusted by the server: shown as plain text, never as Markdown or links.
 */
function WindowView({ observe, image }: { observe: Observed; image?: Image }) {
  const tree = observe.tree.text
  const lines = tree.split('\n').filter(Boolean)
  const title = observe.title.text
  return (
    <>
      <ToolSection className="flex gap-3">
        {image && <ToolImage alt={title || 'Window'} className="shrink-0" image={image} />}
        <div className="flex min-w-0 flex-col gap-0.5 text-[11.5px]">
          <span className="truncate text-foreground/90" title={title}>
            {title ? `“${title}”` : 'untitled window'}
          </span>
          <span className="text-muted-foreground/80">
            {observe.app}
            {observe.capture && ` · ${observe.capture.width}×${observe.capture.height}`}
            {!image && ' · tree only'}
          </span>
        </div>
      </ToolSection>
      {lines.length > 0 && (
        <Collapsible className="group/tree border-t border-border/60">
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
            <span className="transition-transform group-data-[state=open]/tree:rotate-90">›</span>
            Accessibility tree · {plural(lines.length, 'line')}
            {observe.truncated && <span className="text-warning">truncated</span>}
            <span className="ml-auto text-muted-foreground/60">screen text, untrusted</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mx-2.5 mb-2 max-h-72 overflow-auto rounded-sm bg-terminal px-2.5 py-2 text-[11px] leading-[1.5] whitespace-pre text-foreground/80">
              {tree}
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
  return (
    <ToolSection>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className={toneClass[toneOf(code)]}>{refusalText(code)}</span>
        <span className="text-muted-foreground/60">{code}</span>
      </div>
      {message && !waits && <p className="break-words text-muted-foreground">{message}</p>}
    </ToolSection>
  )
}

/**
 * What this call waits on the user for, while it waits; once answered, what the user decided. A confirmation is pinned
 * to its task (`pending[].task`), consent to its app, and either shows only under the newest waiting card of that
 * task, never repeated on older ones.
 */
function Raised({
  call,
  details,
  app,
  session,
  conversation,
}: {
  call: ToolCallView
  details?: ComputerDetails
  app: string
  session?: Session
  conversation?: number
}) {
  const project = useDocOf(1, SessionDoc)
  const code = waitingOf(details) ?? (details?.status === 'denied' ? 'denied' : undefined)
  const task = details?.task?.id
  const newest = useNewestWaiting(call, task)
  if (!session || conversation === undefined || !code) return null
  if (code === 'user_active') {
    const granted = session.takeovers.some((t) => t.app.toLowerCase() === app.toLowerCase())
    return newest || granted ? (
      <ToolSection>
        <Takeover app={app} conversation={conversation} granted={granted} />
      </ToolSection>
    ) : null
  }
  const mine = (request: Session['pending'][number]) =>
    request.kind === 'confirm'
      ? request.task === task
      : request.kind === 'consent' && request.app.toLowerCase() === app.toLowerCase()
  if (newest && session.pending.some(mine))
    return (
      <ToolSection>
        <Requests conversation={conversation} only={mine} session={session} />
      </ToolSection>
    )
  if (code === 'consent_required' || code === 'denied')
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
  const details = detailsOf(call)
  const observe = details?.observe
  const app = text(call.args.app)
  const listing = call.args.window === undefined
  const summary = summaryOf(details)
  const items = (
    Array.isArray(summary.apps)
      ? summary.apps
      : Array.isArray(summary.windows)
        ? summary.windows
        : []
  ) as Record<string, unknown>[]
  const status = details?.status
  const failed = toneOf(status) !== 'good'
  return (
    <Tool>
      <ToolHeader
        meta={
          <>
            {failed && <Verdict status={status} />}
            {call.args.zoom !== undefined && <span>zoom</span>}
            {call.args.evidence === true && <span className="text-brand">evidence</span>}
            {listing && items.length > 0 && (
              <span>{plural(items.length, app ? 'window' : 'app')}</span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name="observe"
        state={headerState(call.status, toneOf(status))}
        title={
          listing
            ? app
              ? `${app} · windows`
              : 'running apps'
            : `${app}${observe?.title.text ? ` · “${observe.title.text}”` : call.args.window !== undefined ? ` · ${scalar(call.args.window)}` : ''}`
        }
      />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">reading the window…</Shimmer>
          </ToolSection>
        )}
        {observe && <WindowView image={imageAt(call, observe)} observe={observe} />}
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
        {failed && <Problem code={status} message={details?.message} />}
        {status === 'setup' && typeof summary.install === 'string' && (
          <ToolOutput output={summary.install} />
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      <TaskLine details={details} />
    </Tool>
  )
}

function Steps({
  call,
  steps,
  done,
}: {
  call: ToolCallView
  steps: Step[]
  done: readonly ActStepDetails[]
}) {
  const live = liveSteps(call.output)
  return (
    <ToolSection label="Steps · labels are screen text">
      {steps.map((step, index) => {
        const outcome = done[index]
        const state: Outcome = outcome
          ? outcome.status
          : call.status === 'running'
            ? ((live.get(index + 1) === 'sending' ? 'running' : (live.get(index + 1) as Outcome)) ??
              'not_run')
            : 'not_run'
        const waits = !!outcome?.code && asks.includes(outcome.code)
        return (
          <div
            className="flex min-w-0 items-start gap-2 leading-[1.7]"
            data-computer-step={state}
            key={index}
          >
            <Mark outcome={waits ? 'waiting' : state} />
            <span className="w-20 shrink-0 whitespace-nowrap text-foreground/90">
              {(step.kind ?? '?').replace('_', ' ')}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-muted-foreground"
                title={describe(step, outcome)}
              >
                {describe(step, outcome)}
              </span>
              {(state === 'refused' || state === 'failed') && (
                <span className={cn('block break-words', waits ? 'text-warning' : 'text-error')}>
                  {outcome?.code ? refusalText(outcome.code) : ''}
                  {outcome?.message && !waits
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

type Decision = NonNullable<ComputerDetails['act']>['decisions'][number]
const decisionTone: Record<string, string> = {
  verified: 'text-success',
  done: 'text-success',
  acted: 'text-foreground/80',
  reobserved: 'text-muted-foreground',
  no_effect: 'text-warning',
  escalated: 'text-warning',
}

/** Jev's decisions: what it picked, how sure it was, whether it worked. Alternatives on hover. */
function Decisions({ decisions: all }: { decisions: readonly Decision[] }) {
  // Jev journals one entry per outcome of a step (acted, then verified): show each step once, with its last outcome.
  const decisions = all.filter((d, index) => all[index + 1]?.step !== d.step)
  if (!decisions.length) return null
  return (
    <ToolSection label="Jev decisions · labels are screen text">
      {decisions.map((decision, index) => {
        const pick = decision.top.find((t) => t.id === decision.chose) ?? decision.top[0]
        const alternatives = decision.top
          .filter((t) => t !== pick)
          .map((t) => `${t.label.text} ${Math.round(t.p * 100)}%`)
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
                  <span className="text-foreground/90">“{pick?.label.text ?? decision.chose}”</span>
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

/** One tone for a finished act, shared by the header icon and the summary on the right. */
function actTone(details: ComputerDetails | undefined, expected: boolean): Tone {
  const act = details?.act
  const steps = act?.steps ?? []
  if (act?.mode === 'goal')
    return details?.status === 'done'
      ? 'good'
      : details?.status === 'escalated'
        ? 'wait'
        : toneOf(details?.status)
  if (waitingOf(details)) return 'wait'
  // A step that was sent and failed is a failure, even when it was the first one.
  if (steps.some((s) => s.status === 'failed')) return 'bad'
  if (!steps.some((s) => s.status === 'delivered')) return toneOf(details?.status)
  if (steps.some((s) => s.status === 'refused' || s.status === 'failed')) return 'bad'
  if (steps.some((s) => s.status !== 'delivered')) return 'wait'
  return !expected || act?.verdict === 'satisfied' ? 'good' : 'wait'
}

export function Act({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { id, session } = useSession()
  const details = detailsOf(call)
  const act = details?.act
  const app = text(call.args.app)
  const goal = call.args.goal as
    | { text?: string; params?: Record<string, string>; done_when?: unknown[] }
    | undefined
  const steps = (Array.isArray(call.args.actions) ? call.args.actions : []) as Step[]
  const done = act?.steps ?? []
  // While a goal runs its decisions are only in the session journal; the result carries them once done.
  const decisions: readonly Decision[] =
    act?.decisions ??
    session?.journal.flatMap((entry) =>
      entry.call === call.id && entry.decision
        ? [
            {
              ...entry.decision,
              top: entry.decision.top.map((t) => ({
                ...t,
                label: { text: t.label, untrusted: true as const },
              })),
            },
          ]
        : [],
    ) ??
    []
  const before = useBefore(call, app)
  const after = imageAt(call, details?.observe)
  const delivered = done.filter((s) => s.status === 'delivered').length
  const status = details?.status
  const expected = Array.isArray(call.args.expect) && call.args.expect.length > 0
  const waiting = waitingOf(details)
  // Nothing was sent: the whole call was turned down before its first step (no task, consent, stopped…).
  const turnedDown =
    !goal && details && !done.some((s) => s.status === 'delivered' || s.status === 'unknown')
      ? (done.find((s) => s.code)?.code ??
        (done.some((s) => s.status === 'failed') ? 'failed' : status))
      : undefined
  const reason = done.find((s) => s.code || s.message)?.message ?? details?.message
  const tone = actTone(details, expected)
  return (
    <Tool defaultOpen>
      <ToolHeader
        action={call.status === 'running' ? <StopButton conversation={id} /> : undefined}
        meta={
          <>
            {!details ? null : goal ? (
              status === 'escalated' ? (
                <span className="text-warning">escalated</span>
              ) : (
                <Verdict status={status} />
              )
            ) : waiting ? (
              <span className="text-warning">{refusalText(waiting)}</span>
            ) : done.some((s) => s.status === 'unknown') ? (
              <span className="text-warning">outcome unknown</span>
            ) : delivered > 0 ? (
              <span className={toneClass[tone]}>
                {delivered}/{steps.length} delivered
              </span>
            ) : (
              <Verdict status={turnedDown} />
            )}
            {call.args.foreground === true && <span className="text-warning">foreground</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name={goal ? 'act · goal' : 'act'}
        state={headerState(call.status, tone)}
        title={
          goal
            ? `${app} · ${text(goal.text)}`
            : `${app}${details?.observe?.title.text ? ` · “${details.observe.title.text}”` : ''}`
        }
      />
      <ToolContent>
        {goal?.params && Object.keys(goal.params).length > 0 && (
          <ToolSection className="text-muted-foreground">
            {Object.keys(goal.params).join(' · ')}
            <span className="text-muted-foreground/60"> · values hidden</span>
          </ToolSection>
        )}
        {!goal && steps.length > 0 && (!turnedDown || waiting) && (
          <Steps call={call} done={done} steps={steps} />
        )}
        {goal && <Decisions decisions={decisions} />}
        {goal && status === 'escalated' && act?.escalationReason && (
          <ToolSection>
            <p className="text-warning">
              {escalations[act.escalationReason] ?? act.escalationReason}
            </p>
            {details?.message && (
              <p className="break-words text-muted-foreground">{details?.message}</p>
            )}
            <p className="text-muted-foreground/70">
              Handed back to the agent to act explicitly or narrow the goal.
            </p>
          </ToolSection>
        )}
        {turnedDown && !waiting && <Problem code={turnedDown} message={reason} />}
        {!goal && delivered > 0 && (
          <Expect
            predicates={Array.isArray(call.args.expect) ? call.args.expect : []}
            verdict={act?.verdict}
          />
        )}
        {goal?.done_when && goal.done_when.length > 0 && details && (
          <Expect
            predicates={goal.done_when}
            verdict={status === 'done' ? (act?.verdict ?? 'satisfied') : 'unknown'}
          />
        )}
        {call.status === 'running' && !steps.length && !decisions.length && (
          <ToolSection>
            <Shimmer className="text-[12px]">working…</Shimmer>
          </ToolSection>
        )}
        <Shots after={after} before={before} />
        <Raised app={app} call={call} conversation={id} details={details} session={session} />
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      <TaskLine details={details} />
    </Tool>
  )
}

export function Apps({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { id, session } = useSession()
  const details = detailsOf(call)
  const summary = summaryOf(details)
  const launch = text(call.args.launch)
  const apps = (Array.isArray(summary.apps) ? summary.apps : []) as Record<string, unknown>[]
  const status = details?.status
  const failed = !!status && toneOf(status) !== 'good'
  return (
    <Tool>
      <ToolHeader
        meta={
          <>
            {launch || failed ? (
              <Verdict status={status} />
            ) : (
              apps.length > 0 && <span>{plural(apps.length, 'app')}</span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name={launch ? 'launch' : 'apps'}
        state={headerState(call.status, toneOf(status))}
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
        {failed && <Problem code={status} message={details?.message} />}
        {launch && (
          <Raised app={launch} call={call} conversation={id} details={details} session={session} />
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      <TaskLine details={details} />
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
