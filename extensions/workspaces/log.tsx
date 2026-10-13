import { cn } from 'cn'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  GitMergeIcon,
  SquareArrowOutUpRightIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useConversation, useConversations, useToolDuration, useUltimate } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { useWorkspaceIndex } from './data.tsx'
import type { LanderEntry, LanderOutcome, SubmitResult } from './types.ts'

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
        <Open className="-my-0.5" id={Number(lander)} label="lander" />
      </header>
      <div className="space-y-1.5 pl-5.5">
        {outcome ? (
          <OutcomeBody outcome={outcome} />
        ) : (
          <p className="whitespace-pre-wrap text-muted-foreground">
            {body.split('\n').slice(1).join('\n')}
          </p>
        )}
      </div>
    </section>
  )
}

function Line({ icon, children, at }: { icon: ReactNode; children: ReactNode; at: number }) {
  return (
    <div className="flex items-center gap-2 pl-4 font-mono text-[11px] text-muted-foreground">
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <time className="shrink-0 text-muted-foreground/60">{time(at)}</time>
    </div>
  )
}

/** One `ultimate.lander` entry: a submission header, a step, a check result, or the outcome card. */
export function LanderLogEntry({ entry }: { entry: EntryRecord }) {
  const data = entry.data as LanderEntry
  const { entries } = useConversation()
  // A running check's line gives way to its result.
  const command = /^(?:checking|rerunning): (.*)$/s.exec(data.step ?? '')?.[1]
  if (
    command !== undefined &&
    entries.some(
      (later) =>
        later.id > entry.id &&
        (later.data as LanderEntry | undefined)?.submission === data.submission &&
        (later.data as LanderEntry).check?.command === command,
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
  if (data.step === 'queued')
    return (
      <div className="flex items-center gap-2 border-t border-border/60 pt-3 font-mono text-[12px]">
        <GitMergeIcon className="size-3.5 shrink-0 text-brand" />
        <span className="min-w-0 flex-1 truncate">
          W{data.conversationId} · {short(data.tip)} → {data.target}
          <span className="text-muted-foreground"> · {data.submission}</span>
        </span>
        <Open id={data.conversationId} />
      </div>
    )
  if (data.check)
    return (
      <Line
        at={data.at}
        icon={
          data.check.result === 'passed' ? (
            <CheckIcon className="size-3 shrink-0 text-success" />
          ) : data.check.result === 'flaky' ? (
            <TriangleAlertIcon className="size-3 shrink-0 text-warning" />
          ) : (
            <XIcon className="size-3 shrink-0 text-error" />
          )
        }
      >
        {data.check.command}
        {data.check.result !== 'passed' && ` · ${data.check.result}`}
      </Line>
    )
  return (
    <Line
      at={data.at}
      icon={<CircleDotIcon className="size-3 shrink-0 text-muted-foreground/60" />}
    >
      {data.step}
    </Line>
  )
}

/** The submission's state now: queued, its current step, or how it ended. */
function useSubmission(id: string | undefined) {
  const index = useWorkspaceIndex()
  if (!id) return undefined
  const queued = index.queue.find((item) => item.id === id)
  if (queued) {
    const position = index.queue
      .filter((item) => item.source === queued.source)
      .findIndex((item) => item.id === id)
    return queued.state === 'landing'
      ? { text: queued.step ?? 'landing' }
      : { text: position ? `queued · ${position} ahead` : 'queued' }
  }
  const outcome = index.results[id]
  return outcome ? { outcome } : undefined
}

const parse = (output: string) => {
  try {
    return JSON.parse(output) as unknown
  } catch {
    return undefined
  }
}

/** `workspace` calls; a submit shows its submission live and links to the lander conversation. */
export function WorkspaceCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const action = typeof call.args.action === 'string' ? call.args.action : ''
  const result = call.status === 'done' ? parse(call.output) : undefined
  const submitted = action === 'submit' ? (result as SubmitResult | undefined) : undefined
  const state = useSubmission(submitted?.id)
  const status = state?.outcome ? headline(state.outcome) : state?.text
  return (
    <Tool defaultOpen={call.status === 'error' || state?.outcome?.outcome === 'failed'}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={<>{duration && <span>{duration}</span>}</>}
          name="workspace"
          state={call.status}
          title={
            <>
              {action}
              {status && (
                <span
                  className={cn(
                    'ml-2',
                    state?.outcome?.outcome === 'failed' && 'text-error',
                    state?.outcome?.outcome === 'landed' && !state.outcome.reason && 'text-success',
                  )}
                >
                  {status}
                </span>
              )}
            </>
          }
        />
        {submitted && <Open className="mr-1 h-6" id={submitted.lander} />}
      </div>
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
