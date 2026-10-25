/**
 * `computer_task` in the transcript. `start` becomes the task card: the user's words, the sub-goal checklist and the
 * criteria, live from the session while the task runs. `finish` becomes the report: each criterion met, unmet or
 * unknown with its evidence, and an honest headline when the result is partial or blocked. Other actions are one line.
 */
import {
  CheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleSlashIcon,
  MonitorIcon,
  XIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { cn, formatDuration, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import type { Evidence, Subgoal, TaskSpec, TaskState } from './types.ts'
import { Requests } from './requests.tsx'
import { AnchorLine, parseResult, predicate, refusalText, short, useSession } from './shared.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

const subgoalMarks: Record<Subgoal['status'], ReactNode> = {
  done: <CheckIcon className="size-3.5 text-success" />,
  active: <CircleDotIcon className="size-3.5 text-brand" />,
  pending: <CircleDashedIcon className="size-3.5 text-muted-foreground/60" />,
  blocked: <CircleSlashIcon className="size-3.5 text-warning" />,
  skipped: <CircleSlashIcon className="size-3.5 text-muted-foreground/60" />,
  needs_reverify: <CircleHelpIcon className="size-3.5 text-warning" />,
}

const taskStatus: Record<TaskState['status'], [string, string]> = {
  awaiting_confirmation: ['waits for you', 'text-warning'],
  active: ['working', 'text-brand'],
  stopped: ['stopped', 'text-error'],
  paused_by_user: ['paused', 'text-warning'],
  done: ['done', 'text-success'],
  partial: ['partial', 'text-warning'],
  blocked: ['blocked', 'text-error'],
}

/** The frame both task cards share, like the goal and subagent cards: accent rule, mono header. */
function Frame({
  header,
  children,
  tone = 'brand',
}: {
  header: ReactNode
  children: ReactNode
  tone?: 'brand' | 'warning' | 'error' | 'success'
}) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-md border border-border border-l-2 bg-muted/20',
        tone === 'brand' && 'border-l-brand/50',
        tone === 'warning' && 'border-l-warning/70',
        tone === 'error' && 'border-l-error/70',
        tone === 'success' && 'border-l-success/60',
      )}
      data-computer-task
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {header}
      </header>
      {children}
    </section>
  )
}

function Subgoals({ task }: { task: TaskState }) {
  return (
    <ol className="space-y-1 px-3 py-2.5">
      {task.subgoals.map((subgoal) => (
        <li
          className="flex items-start gap-2 text-[13px] leading-5"
          data-computer-subgoal={subgoal.status}
          key={subgoal.id}
        >
          <span className="mt-0.5 shrink-0">{subgoalMarks[subgoal.status]}</span>
          <span
            className={cn(
              'min-w-0',
              subgoal.status === 'done' && 'text-muted-foreground',
              subgoal.status === 'active' && 'text-foreground',
            )}
          >
            {subgoal.text}
            {(subgoal.attempts > 1 ||
              subgoal.status === 'needs_reverify' ||
              subgoal.evidence.length > 0) && (
              <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                {subgoal.status === 'needs_reverify' && (
                  <span className="text-warning">re-check · </span>
                )}
                {subgoal.attempts > 1 && `${subgoal.attempts} tries`}
                {subgoal.attempts > 1 && subgoal.evidence.length > 0 && ' · '}
                {subgoal.evidence.length > 0 && plural(subgoal.evidence.length, 'proof')}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** Criteria while the task runs: met ones checked, the rest open. */
function OpenCriteria({ spec, met }: { spec: TaskSpec; met: string[] }) {
  return (
    <div className="border-t border-border/60 px-3 py-2">
      <h3 className="pb-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Done when
      </h3>
      <ul className="space-y-0.5">
        {spec.criteria.map((criterion) => (
          <li className="flex items-start gap-2 text-[12.5px] leading-5" key={criterion.id}>
            <span className="mt-0.5 shrink-0">
              {met.includes(criterion.id) ? (
                <CheckIcon className="size-3.5 text-success" />
              ) : (
                <CircleDashedIcon className="size-3.5 text-muted-foreground/60" />
              )}
            </span>
            <span className={cn('min-w-0', met.includes(criterion.id) && 'text-muted-foreground')}>
              {criterion.text}
              <span className="ml-2 font-mono text-[11px] text-muted-foreground/70">
                {criterion.check === 'evidence' ? 'judged from evidence' : 'verified'}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The task's counters and flags, the way the user sees drift: steps, escalations, loop, drift. */
function Meter({ task }: { task: TaskState }) {
  const { counters, spec } = task
  const flags = [
    task.drift && 'drifting',
    task.loopDetected && 'looping',
    task.replanRequired && 'must replan',
  ].filter(Boolean)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
      <span className={counters.steps >= spec.stop.steps * 0.8 ? 'text-warning' : undefined}>
        steps {counters.steps}/{spec.stop.steps}
      </span>
      <span
        className={counters.escalations >= spec.stop.escalations - 1 ? 'text-warning' : undefined}
      >
        escalations {counters.escalations}/{spec.stop.escalations}
      </span>
      <span>limit {spec.stop.minutes}m</span>
      <span>{spec.scope.apps.join(', ')}</span>
      {flags.map((flag) => (
        <span className="text-warning" key={String(flag)}>
          {flag}
        </span>
      ))}
    </div>
  )
}

function Start({ call }: { call: ToolCallView }) {
  const { id, session } = useSession()
  const parsed = parseResult(call)
  const spec = (call.args.spec ?? {}) as Partial<TaskSpec>
  // The live task, while it is still the one this call started.
  const task = session?.task && session.task.spec.id === spec.id ? session.task : undefined
  const status = task?.status ?? (parsed.status as TaskState['status'] | undefined)
  const [label, tone] = (status && taskStatus[status]) ?? [
    parsed.status ? refusalText(parsed.status) : 'starting',
    'text-muted-foreground',
  ]
  const needs = Array.isArray(parsed.summary.needsConfirmation)
    ? (parsed.summary.needsConfirmation as string[])
    : []
  return (
    <Frame
      header={
        <>
          <MonitorIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Computer task</span>
          {spec.id && <span>{spec.id}</span>}
          <span className={tone}>{label}</span>
          {task && (
            <span className="ml-auto">
              {task.subgoals.filter((s) => s.status === 'done').length}/{task.subgoals.length}{' '}
              sub-goals · {task.criteriaMet?.length ?? 0}/{task.spec.criteria.length} criteria
            </span>
          )}
        </>
      }
      tone={status === 'awaiting_confirmation' ? 'warning' : 'brand'}
    >
      {spec.intent && (
        <p className="px-3 pt-2.5 text-[13px] leading-relaxed whitespace-pre-wrap">
          “{spec.intent}”
        </p>
      )}
      {spec.goal && spec.goal !== spec.intent && (
        <p className="px-3 pt-1 text-[12.5px] leading-snug text-muted-foreground">{spec.goal}</p>
      )}
      {task ? (
        <>
          <Subgoals task={task} />
          <OpenCriteria met={task.criteriaMet ?? []} spec={task.spec} />
          <Meter task={task} />
        </>
      ) : (
        spec.criteria && <OpenCriteria met={[]} spec={spec as TaskSpec} />
      )}
      {task?.status === 'awaiting_confirmation' && session && id !== undefined && (
        <div className="px-3 pb-3">
          <Requests
            compact
            conversation={id}
            only={(request) => request.kind === 'task' || request.kind === 'change'}
            reasons={needs}
            session={session}
          />
        </div>
      )}
      {!task && parsed.status && !taskStatus[parsed.status as TaskState['status']] && (
        <p className="px-3 py-2 font-mono text-[11.5px] text-error">
          {parsed.message ?? refusalText(parsed.status)}
        </p>
      )}
      {call.status === 'error' && <ToolOutput isError output={call.output} />}
    </Frame>
  )
}

type Criterion = {
  id: string
  text: string
  state: 'met' | 'unmet' | 'unknown'
  evidence: Evidence[]
}

const criterionMarks = {
  met: <CheckIcon className="size-3.5 text-success" />,
  unmet: <XIcon className="size-3.5 text-error" />,
  unknown: <CircleHelpIcon className="size-3.5 text-warning" />,
}

/** One piece of evidence, as a compact mono line: what was verified or read, in which app. */
function Proof({ evidence }: { evidence: Evidence }) {
  const where = evidence.app ? `${evidence.app} · ` : ''
  if (evidence.kind === 'verify')
    return (
      <span title={JSON.stringify(evidence.predicates)}>
        {where}verified {evidence.predicates.map(predicate).join(', ')}
      </span>
    )
  if (evidence.kind === 'ax')
    return (
      <span title={evidence.excerpt}>
        {where}screen read ·{' '}
        {short(evidence.excerpt.split('\n').find((line) => line.trim()) ?? '', 60)}
      </span>
    )
  return (
    <span>
      {where}capture {evidence.captureId}
    </span>
  )
}

const headlines = {
  done: ['Done: every criterion verified', 'text-success', 'success'],
  partial: ['Partial: not every criterion is met', 'text-warning', 'warning'],
  blocked: ['Blocked: could not finish', 'text-error', 'error'],
  criteria_unmet: ['Not done yet: criteria unmet', 'text-warning', 'warning'],
} as const

function Finish({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { session } = useSession()
  const parsed = parseResult(call)
  const criteria = (
    Array.isArray(parsed.summary.criteria) ? parsed.summary.criteria : []
  ) as Criterion[]
  const asked = text(call.args.outcome)
  const status = parsed.status ?? (call.status === 'running' ? 'running' : '')
  const [headline, tone, frame] = headlines[status as keyof typeof headlines] ?? [
    status === 'running' ? 'Verifying criteria…' : refusalText(status),
    'text-muted-foreground',
    'brand',
  ]
  const summary = text(call.args.summary)
  const met = criteria.filter((c) => c.state === 'met').length
  const task = session?.task
  const checks = new Map(task?.spec.criteria.map((c) => [c.id, c.check]))
  // NEXT(server): evidence gains `criterion`; then match on it instead of on the predicates.
  const proofs = (criterion: Criterion) => {
    const check = checks.get(criterion.id)
    return criterion.evidence.filter((e) =>
      check === 'evidence' || check === undefined
        ? e.kind !== 'verify'
        : e.kind === 'verify' && JSON.stringify(e.predicates) === JSON.stringify(check),
    )
  }
  return (
    <Frame
      header={
        <>
          <MonitorIcon className="size-3.5 text-brand" />
          <span className="text-foreground">Computer task report</span>
          {task && <span>{task.spec.id}</span>}
          {asked && asked !== status && status !== 'running' && <span>asked: {asked}</span>}
          <span className="ml-auto">{duration}</span>
        </>
      }
      tone={frame}
    >
      <div className="space-y-1 px-3 pt-2.5" data-computer-outcome={status}>
        <p className={cn('text-[13px]', tone)}>{headline}</p>
        {criteria.length > 0 && (
          <p className="font-mono text-[11px] text-muted-foreground">
            {met} of {criteria.length} criteria met
            {task &&
              ` · ${task.counters.steps} steps · ${task.counters.escalations} escalations · ${formatDuration(Date.now() - task.counters.startedAt).split(' ')[0]}`}
          </p>
        )}
      </div>
      {summary && (
        <p className="px-3 pt-2 text-[13px] leading-relaxed whitespace-pre-wrap">{summary}</p>
      )}
      {criteria.length > 0 && (
        <ul className="space-y-1.5 px-3 py-2.5" data-computer-criteria>
          {criteria.map((criterion) => {
            const fresh = proofs(criterion)
            return (
              <li
                className="flex items-start gap-2 text-[13px] leading-5"
                data-computer-criterion={criterion.state}
                key={criterion.id}
              >
                <span className="mt-0.5 shrink-0">{criterionMarks[criterion.state]}</span>
                <span className="min-w-0 flex-1">
                  <span className={criterion.state === 'met' ? 'text-foreground' : undefined}>
                    {criterion.text}
                  </span>
                  <span
                    className={cn(
                      'ml-2 font-mono text-[11px]',
                      criterion.state === 'met'
                        ? 'text-success'
                        : criterion.state === 'unmet'
                          ? 'text-error'
                          : 'text-warning',
                    )}
                  >
                    {criterion.state}
                  </span>
                  {criterion.state === 'met' && fresh.length > 0 && (
                    <span className="block space-y-0.5 pt-0.5 font-mono text-[11px] text-muted-foreground">
                      {fresh.slice(-2).map((evidence, index) => (
                        <span className="block truncate" key={index}>
                          <Proof evidence={evidence} />
                        </span>
                      ))}
                    </span>
                  )}
                  {criterion.state !== 'met' && (
                    <span className="block pt-0.5 font-mono text-[11px] text-muted-foreground">
                      {checks.get(criterion.id) === 'evidence'
                        ? 'no evidence recorded'
                        : criterion.state === 'unmet'
                          ? 'checked on screen at finish: not true'
                          : 'could not be checked at finish'}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {task && task.status !== 'done' && task.subgoals.some((s) => s.status !== 'done') && (
        <div className="border-t border-border/60">
          <h3 className="px-3 pt-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
            Sub-goals
          </h3>
          <Subgoals task={task} />
        </div>
      )}
      {status === 'criteria_unmet' && (
        <p className="border-t border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          The agent asked to finish as done, which was refused. It can verify the rest or report
          partial.
        </p>
      )}
      {call.status === 'error' && <ToolOutput isError output={call.output} />}
      <ToolDiagnostics diagnostics={call.diagnostics} />
    </Frame>
  )
}

/** Sub-goals, activate, checkpoint, replan and status: the change in one line, with the task anchor. */
function Step({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const parsed = parseResult(call)
  const action = text(call.args.action)
  const list = (
    Array.isArray(call.args.list)
      ? call.args.list
      : Array.isArray(call.args.subgoals)
        ? call.args.subgoals
        : []
  ) as { id: string; text: string }[]
  const title =
    action === 'activate'
      ? text(call.args.id)
      : action === 'checkpoint'
        ? text(call.args.assessment)
        : action === 'replan'
          ? text(call.args.reason)
          : action === 'subgoals'
            ? list.map((s) => s.text).join(' → ')
            : ''
  const ok = ['active', 'done', 'partial', 'blocked'].includes(parsed.status ?? '')
  return (
    <Tool>
      <ToolHeader
        meta={
          <>
            {parsed.status && !ok && (
              <span
                className={
                  parsed.status === 'awaiting_confirmation' ? 'text-warning' : 'text-error'
                }
              >
                {refusalText(parsed.status)}
              </span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name={`task · ${action || '…'}`}
        state={call.status}
        title={title}
      />
      <ToolContent>
        {list.length > 0 && (
          <ToolSection>
            <ol className="space-y-0.5">
              {list.map((subgoal) => (
                <li className="flex gap-2" key={subgoal.id}>
                  <span className="w-6 shrink-0 text-muted-foreground">{subgoal.id}</span>
                  <span className="min-w-0 text-foreground/90">{subgoal.text}</span>
                </li>
              ))}
            </ol>
          </ToolSection>
        )}
        {parsed.message && (
          <ToolSection className="text-muted-foreground">{parsed.message}</ToolSection>
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      <AnchorLine anchor={parsed.anchor} />
    </Tool>
  )
}

export function TaskCall({ call }: { call: ToolCallView }) {
  const action = text(call.args.action)
  if (action === 'start') return <Start call={call} />
  if (action === 'finish') return <Finish call={call} />
  // NEXT(server): a `complete` action is coming; it lands in Step until it needs its own look.
  return <Step call={call} />
}
