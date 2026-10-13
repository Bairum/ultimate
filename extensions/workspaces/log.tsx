import { cn } from 'cn'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  SquareArrowOutUpRightIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useConversation, useConversations, useToolDuration, useUltimate } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { useWorkspaceIndex } from './data.tsx'
import type { LanderEntry, LanderOutcome, LanderStep, SubmitResult } from './types.ts'

const short = (sha: string) => sha.slice(0, 7)
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** "open #id", with a dot while that conversation works. */
function Open({ id, className, label }: { id: number; className?: string; label?: string }) {
  const { switchConversation } = useUltimate()
  const busy = useConversations().find((conversation) => conversation.id === id)?.busy
  return (
    <Button
      className={cn(
        'h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground',
        className,
      )}
      onClick={() => switchConversation(id)}
      size="xs"
      title={`Show conversation #${id}`}
      variant="ghost"
    >
      {busy && <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />}
      <SquareArrowOutUpRightIcon className="size-3" />
      open {label ? `${label} ` : ''}#{id}
    </Button>
  )
}

/** "Landed 115f168 on main · pushed to origin/main", or "Not landed: <reason>". */
function headline(outcome: LanderOutcome, target?: string) {
  if (outcome.outcome === 'failed') return `Not landed: ${outcome.reason ?? 'failed'}`
  const on = target ? ` on ${target}` : ''
  const landed = outcome.commits?.length
    ? `Landed ${short(outcome.sha!)}${on}`
    : `Nothing new to land${on}`
  if (outcome.pushed) return `${landed} · pushed to ${outcome.pushed}`
  return outcome.reason ? `${landed} · ${outcome.reason}` : `${landed} · not pushed`
}

/** What the outcome holds beyond its headline: commits, flaky checks, the output tail. */
function OutcomeBody({ outcome }: { outcome: LanderOutcome }) {
  return (
    <>
      {outcome.commits && outcome.commits.length > 0 && (
        <ul className="space-y-0.5">
          {outcome.commits.map((commit) => (
            <li className="truncate" key={commit} title={commit}>
              <span className="text-muted-foreground">{commit.split(' ')[0]}</span>{' '}
              {commit.slice(commit.indexOf(' ') + 1)}
            </li>
          ))}
        </ul>
      )}
      {outcome.flaky?.map((command) => (
        <p className="text-warning" key={command}>
          flaky: {command}
        </p>
      ))}
      {outcome.needsRestart && <p className="text-warning">Needs restart.</p>}
      {outcome.hint && <p className="text-muted-foreground">{outcome.hint}</p>}
      {outcome.output && (
        <Collapsible className="group/tail">
          <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/tail:rotate-90" />
            Output
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ToolOutput className="px-0" isError output={outcome.output} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  )
}

const tone = {
  landed: ['border-l-success/70', 'text-success', CheckIcon],
  pushFailed: ['border-l-warning/70', 'text-warning', TriangleAlertIcon],
  failed: ['border-l-error/70', 'text-error', XIcon],
} as const

/**
 * The lander's report in the submitter's transcript, as a card: landed (success), landed locally but the push failed
 * (warning), or not landed (error), from the stored outcome; the message text once that outcome was pruned.
 */
export function LanderReport({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const results = useWorkspaceIndex().results
  const message = entry.model?.[0]
  const text =
    message?.role !== 'user'
      ? ''
      : typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  const report =
    /^\[lander\] Submission (\S+) \(W\d+, \w+\) ([\s\S]*?)\nLog: lander conversation #(\d+)\.$/.exec(
      text,
    )
  if (!report) return core
  const [, id, body, lander] = report
  const outcome = results[id]
  const kind = !outcome
    ? /^(had nothing new to land|landed as)/.test(body) && !body.includes('\nPush failed')
      ? 'landed'
      : body.startsWith('landed locally')
        ? 'pushFailed'
        : 'failed'
    : outcome.outcome === 'failed'
      ? 'failed'
      : outcome.reason
        ? 'pushFailed'
        : 'landed'
  const [border, color, Icon] = tone[kind]
  return (
    <section
      className={cn(
        'min-w-0 space-y-1.5 rounded-md border border-l-2 border-border bg-muted/20 px-3 py-2.5 font-mono text-[12px]',
        border,
      )}
      data-lander-report={kind}
    >
      <header className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', color)} />
        <span className="min-w-0 flex-1 break-words text-foreground">
          {outcome ? headline(outcome, outcome.target) : body.split('\n')[0]}
        </span>
      </header>
      <div className="space-y-1.5 pl-5.5">
        {outcome ? (
          <OutcomeBody outcome={outcome} />
        ) : (
          <p className="whitespace-pre-wrap text-muted-foreground">
            {body.split('\n').slice(1).join('\n')}
          </p>
        )}
        <Steps lander={Number(lander)} steps={outcome?.steps ?? []} />
      </div>
    </section>
  )
}

function Line({ icon, children, at }: { icon: ReactNode; children: ReactNode; at: number }) {
  return (
    <div className="flex items-center gap-2 pl-4 font-mono text-[11px] leading-5 text-muted-foreground">
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <time className="shrink-0 text-muted-foreground/60">{time(at)}</time>
    </div>
  )
}

/** A step or a check result, as one quiet line. */
function StepLine({ row }: { row: LanderStep }) {
  if (row.check)
    return (
      <Line
        at={row.at}
        icon={
          row.check.result === 'passed' ? (
            <CheckIcon className="size-3 shrink-0 text-success" />
          ) : row.check.result === 'flaky' ? (
            <TriangleAlertIcon className="size-3 shrink-0 text-warning" />
          ) : (
            <XIcon className="size-3 shrink-0 text-error" />
          )
        }
      >
        {row.check.command}
        {row.check.result !== 'passed' && ` · ${row.check.result}`}
      </Line>
    )
  return (
    <Line at={row.at} icon={<CircleDotIcon className="size-3 shrink-0 text-muted-foreground/60" />}>
      {row.step}
    </Line>
  )
}

/** A running check's line gives way to its result, which follows it. */
const running = /^(?:checking|rerunning): (.*)$/s
const superseded = (row: LanderStep, later: readonly LanderStep[]) => {
  const command = running.exec(row.step)?.[1]
  return command !== undefined && later.some((next) => next.check?.command === command)
}

/**
 * A submission's steps behind an "N steps" toggle, ending in a quiet link to the lander conversation's full log.
 * `open` and `onOpenChange` control it; without them it starts collapsed.
 */
function Steps({
  steps,
  lander,
  open,
  onOpenChange,
}: {
  steps: readonly LanderStep[]
  lander: number
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const { switchConversation } = useUltimate()
  const rows = steps.filter((row, index) => !superseded(row, steps.slice(index + 1)))
  return (
    <Collapsible className="group/steps" onOpenChange={onOpenChange} open={open}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/steps:rotate-90" />
        {rows.length ? `${rows.length} step${rows.length === 1 ? '' : 's'}` : 'Steps'}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">
        {rows.map((row, index) => (
          <StepLine key={index} row={row} />
        ))}
        <button
          className="cursor-pointer pt-1 pl-4 font-mono text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => switchConversation(lander)}
          type="button"
        >
          full log in #{lander}
        </button>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One `ultimate.lander` entry: a submission header, a step, a check result, or the outcome card. */
export function LanderLogEntry({ entry }: { entry: EntryRecord }) {
  const data = entry.data as LanderEntry
  const { entries } = useConversation()
  const own = (other: EntryRecord) =>
    other.kind === 'ultimate.lander' && (other.data as LanderEntry).submission === data.submission
  if (
    data.step &&
    superseded(
      data as LanderStep,
      entries
        .filter((later) => later.id > entry.id && own(later))
        .map((later) => later.data as LanderStep),
    )
  )
    return null
  if (data.outcome) {
    const outcome = data as LanderEntry & LanderOutcome
    const landed = data.outcome === 'landed'
    return (
      <div
        className={cn(
          'space-y-1.5 rounded-md border bg-card/50 px-3 py-2 font-mono text-[12px]',
          landed && !data.reason ? 'border-success/40' : 'border-error/40',
        )}
        data-lander-outcome={data.outcome}
      >
        <div className="flex items-center gap-2">
          {landed && !data.reason ? (
            <CheckIcon className="size-3.5 shrink-0 text-success" />
          ) : (
            <XIcon className="size-3.5 shrink-0 text-error" />
          )}
          <span className="min-w-0 flex-1 break-words">{headline(outcome, data.target)}</span>
          <time className="shrink-0 text-[11px] text-muted-foreground/60">{time(data.at)}</time>
        </div>
        <OutcomeBody outcome={outcome} />
      </div>
    )
  }
  // A later submission is queued while an earlier one lands: its group starts when it starts, with its queued line.
  if (data.step === 'queued') return null
  if (data.step === 'started') {
    const queued = entries.find(
      (other) => own(other) && (other.data as LanderEntry).step === 'queued',
    )
    return (
      <div className="space-y-0.5 border-t border-border/60 pt-3">
        <div className="flex items-center gap-2 font-mono text-[12px]">
          <GitMergeIcon className="size-3.5 shrink-0 text-brand" />
          <span className="min-w-0 flex-1 truncate">
            W{data.conversationId} · {short(data.tip)} → {data.target}
            <span className="text-muted-foreground"> · {data.submission}</span>
          </span>
          <Open id={data.conversationId} />
        </div>
        {queued && <StepLine row={queued.data as LanderStep} />}
        <StepLine row={data as LanderStep} />
      </div>
    )
  }
  return <StepLine row={data as LanderStep} />
}

type Submission = {
  tip: string
  target: string
  steps: readonly LanderStep[]
  /** Place in its source's queue while waiting. */
  position?: number
  /** The current step while landing. */
  step?: string
  landing?: boolean
  outcome?: LanderOutcome
}
/** The submission now: queued with its place, landing with its current step, or how it ended. */
function useSubmission(id: string | undefined): Submission | undefined {
  const index = useWorkspaceIndex()
  if (!id) return undefined
  const queued = index.queue.find((item) => item.id === id)
  if (queued)
    return {
      ...queued,
      landing: queued.state === 'landing',
      position: index.queue.filter((item) => item.source === queued.source).indexOf(queued) + 1,
    }
  const outcome = index.results[id]
  return outcome && { ...outcome, outcome }
}

const parse = (output: string) => {
  try {
    return JSON.parse(output) as unknown
  } catch {
    return undefined
  }
}

/** The submission's state as a short chip: queued, the current step, or how it ended. */
function StatusChip({ state }: { state: Submission }) {
  const chip = 'flex min-w-0 items-center gap-1 truncate'
  if (!state.outcome) {
    if (state.landing)
      return (
        <span className={cn(chip, 'text-brand')}>
          <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />
          <span className="truncate">{state.step ?? 'landing'}</span>
        </span>
      )
    return <span className={chip}>queued #{state.position}</span>
  }
  const { outcome } = state
  if (outcome.outcome === 'failed')
    return <span className={cn(chip, 'text-error')}>Not landed</span>
  const landed = outcome.commits?.length ? `Landed ${short(outcome.sha!)}` : 'Nothing new'
  if (outcome.reason)
    return <span className={cn(chip, 'text-warning')}>{landed} · push failed</span>
  return (
    <span className={cn(chip, 'text-success')}>
      {landed}
      {outcome.pushed ? ' · pushed' : ''}
    </span>
  )
}

/** `workspace` calls; a submit follows its submission inline: status chip, live steps, outcome. */
export function WorkspaceCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const action = typeof call.args.action === 'string' ? call.args.action : ''
  const result = call.status === 'done' ? parse(call.output) : undefined
  const submitted = action === 'submit' ? (result as SubmitResult | undefined) : undefined
  const state = useSubmission(submitted?.id)
  // Open while it is queued or lands, closed once it ends, unless toggled.
  const [open, setOpen] = useState<boolean>()
  return (
    <Tool defaultOpen={call.status === 'error'}>
      <ToolHeader
        meta={
          <>
            {state && <StatusChip state={state} />}
            {duration && !state && <span>{duration}</span>}
          </>
        }
        name="workspace"
        state={call.status}
        title={
          state ? (
            <>
              {action} · {short(state.tip)} → {state.target}
            </>
          ) : (
            action
          )
        }
      />
      {submitted && state && (
        <div className="border-t border-border/80 px-2.5 py-1.5">
          <Steps
            lander={submitted.lander}
            onOpenChange={setOpen}
            open={open ?? !state.outcome}
            steps={state.steps}
          />
        </div>
      )}
      <ToolContent>
        {state?.outcome && (
          <ToolSection className="space-y-1.5" label="Lander">
            <OutcomeBody outcome={state.outcome} />
          </ToolSection>
        )}
        <ToolOutput
          isError={call.status === 'error'}
          output={submitted ? submitted.text : call.output}
        />
      </ToolContent>
    </Tool>
  )
}
