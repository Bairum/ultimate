/**
 * `codex_operate` in the transcript: what Codex was asked, how the run ended, which apps it was let into, its steps and
 * screenshots, and what it says it saw. Everything Codex writes is screen-derived: shown as plain text with the
 * untrusted marker, never as Markdown or our own words.
 */
import { CircleStopIcon, LoaderCircleIcon, SendIcon } from 'lucide-react'
import { useState } from 'react'
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
import { api, cn, errorMessage, useConversation, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { SteerAction, StopAction } from './refs.ts'
import type { CodexDetails } from './refs.ts'

type Status = CodexDetails['status']
type Tone = 'good' | 'wait' | 'bad'
const toneClass: Record<Tone, string> = {
  good: 'text-success',
  wait: 'text-warning',
  bad: 'text-error',
}

/** How each outcome reads, and its tone: amber when the user can move it on, red when something is broken. */
const outcomes: Record<Status, [string, Tone]> = {
  done: ['done', 'good'],
  budget: ['8 h limit reached', 'wait'],
  stopped: ['stopped', 'wait'],
  declined: ['app declined', 'wait'],
  failed: ['failed', 'bad'],
  codex_missing: ['Codex not found', 'bad'],
  codex_unsigned: ['Codex not signed by OpenAI', 'bad'],
  computer_use_missing: ['Computer Use not installed', 'bad'],
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const OPEN = '<untrusted_screen_content>'
const CLOSE = '</untrusted_screen_content>'
/** The text inside the server's untrusted boundary, and whether it had one. */
const unwrap = (value: string) => {
  const inner = value.startsWith(OPEN) && value.trimEnd().endsWith(CLOSE)
  return {
    text: inner ? value.trim().slice(OPEN.length, -CLOSE.length).trim() : value,
    untrusted: inner,
  }
}

/** A finished call's card data; `undefined` while it runs or for a result without details. */
const detailsOf = (call: ToolCallView) =>
  call.result ? (call.details as CodexDetails | undefined) : undefined

/** The marker every piece of Codex-written text carries: shown as plain text, never acted on. */
function Untrusted() {
  return (
    <span className="ml-1.5 text-[10.5px] text-muted-foreground/60">
      written by Codex, untrusted
    </span>
  )
}

/**
 * Progress while a call runs, read from its streamed output: `Step n: <tool>` lines and Codex's own messages (both
 * inside the untrusted boundary), and our own `Guidance from the …:` lines, in the order they happened.
 */
function liveOf(output: string) {
  const steps: { tool?: string; guidance?: string }[] = []
  let message = ''
  // Reconnecting until the next step or message shows Codex is through.
  let reconnecting = false
  const blocks = output.split(new RegExp(`(${OPEN}[\\s\\S]*?${CLOSE})`))
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block.startsWith(OPEN)) {
      const inner = unwrap(block).text
      if ((blocks[index - 1] ?? '').endsWith('Codex is reconnecting to OpenAI (')) {
        reconnecting = true
        continue
      }
      reconnecting = false
      if (/Step \d+: $/.test(blocks[index - 1] ?? '')) steps.push({ tool: inner })
      else message = inner
      continue
    }
    for (const line of block.split('\n')) {
      if (line.startsWith('Guidance from the ') || line.startsWith('Connection to OpenAI dropped'))
        steps.push({ guidance: line })
      if (line.startsWith('Connection to OpenAI dropped')) reconnecting = false
    }
  }
  return { steps, message, reconnecting, tools: steps.filter((step) => step.tool).length }
}

/** A step's outcome as one mark, the same glyphs as the computer-use step lists. */
function Mark({ status }: { status: string }) {
  const [glyph, tone, label] =
    status === 'completed'
      ? ['✓', 'text-success', 'completed']
      : status === 'running'
        ? ['●', 'animate-pulse-dot text-brand', 'running']
        : status === 'failed' || status === 'declined'
          ? ['✗', 'text-error', status]
          : ['?', 'text-warning', status || 'unknown']
  return (
    <span aria-label={label} className={cn('w-3 shrink-0 text-center', tone)}>
      {glyph}
    </span>
  )
}

/** Stop beside a running call's header: interrupts this conversation's Codex turn. */
function StopButton({ conversation }: { conversation: number }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-error hover:bg-error/10"
      data-codex-stop
      disabled={busy}
      onClick={() => {
        setBusy(true)
        api
          .action(StopAction, { conversation })
          .catch((error: unknown) => console.error(errorMessage(error)))
          .finally(() => setBusy(false))
      }}
      title="Stop Codex in this conversation"
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

/** "Tell Codex…" under a running call: sends the user's guidance into the active turn. */
function SteerBox({ conversation }: { conversation: number }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = () => {
    const guidance = value.trim()
    if (!guidance || busy) return
    setBusy(true)
    setError('')
    api
      .action(SteerAction, { conversation, text: guidance })
      .then(() => setValue(''))
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="border-t border-border/60 px-2.5 py-1.5">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <input
          aria-label="Tell Codex"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          data-codex-steer
          disabled={busy}
          maxLength={4000}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Tell Codex…"
          value={value}
        />
        <button
          aria-label="Send to Codex"
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40"
          disabled={busy || !value.trim()}
          type="submit"
        >
          {busy ? (
            <LoaderCircleIcon className="size-3 motion-safe:animate-spin" />
          ) : (
            <SendIcon className="size-3" />
          )}
        </button>
      </form>
      {error && <p className="mt-1 text-[11px] text-error">{error}</p>}
    </div>
  )
}

/** Guidance sent while the run worked, in our words: shown as such, never as Codex's. */
function Guidance({ guidance }: { guidance: CodexDetails['guidance'] }) {
  if (!guidance?.length) return null
  return (
    <ToolSection label="Guidance">
      {guidance.map((item, index) => (
        <p className="break-words whitespace-pre-wrap text-muted-foreground" key={index}>
          <span className="text-foreground/80">{item.from === 'user' ? 'You' : 'Operator'}:</span>{' '}
          {item.text}
          {item.delivery === 'restarted' && (
            <span className="ml-1.5 text-[10.5px] text-warning">
              steer refused, turn restarted with it
            </span>
          )}
        </p>
      ))}
    </ToolSection>
  )
}

/** Why the run did not finish as done, in words, with the code and the reason (Codex's own reason is untrusted). */
function Problem({ status, error }: { status: Status; error?: string }) {
  const [words, tone] = outcomes[status]
  const reason = error ? unwrap(error) : undefined
  return (
    <ToolSection>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className={toneClass[tone]}>{words}</span>
        {words !== status && <span className="text-muted-foreground/60">{status}</span>}
      </div>
      {reason?.text && (
        <p className="break-words whitespace-pre-wrap text-muted-foreground">
          {reason.text}
          {reason.untrusted && <Untrusted />}
        </p>
      )}
    </ToolSection>
  )
}

const consentTone: Record<CodexDetails['apps'][number]['consent'], string> = {
  accepted: 'text-success',
  declined: 'text-error',
  'declined (unrecognised)': 'text-error',
  timeout: 'text-warning',
}

/** The apps Codex asked for, each with how the request was answered. */
function Apps({ apps }: { apps: CodexDetails['apps'] }) {
  if (!apps.length) return null
  return (
    <ToolSection label="Apps · names from Codex, untrusted">
      {apps.map((app, index) => (
        <div className="flex min-w-0 items-baseline gap-2 leading-[1.7]" key={index}>
          <span className="min-w-0 flex-1 truncate text-foreground/90" title={app.app.text}>
            “{app.app.text}”
          </span>
          <span className={cn('shrink-0', consentTone[app.consent])}>
            {app.consent === 'accepted'
              ? 'allowed'
              : app.consent === 'timeout'
                ? 'no answer in 5 min'
                : app.consent}
          </span>
        </div>
      ))}
    </ToolSection>
  )
}

/** What Codex says it saw and did: plain text in a terminal block, labelled as Codex's, never rendered as Markdown. */
function Answer({ answer }: { answer: string }) {
  if (!answer.trim()) return null
  return (
    <ToolSection label="Codex reports · from the screen, untrusted">
      <pre
        className="max-h-72 overflow-auto rounded-sm border-l-2 border-l-muted-foreground/30 bg-terminal px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground/85"
        data-codex-answer
      >
        {answer}
      </pre>
    </ToolSection>
  )
}

/** The steps, folded: the tool Codex called and how it came out, timed from the first step. */
function Steps({ steps, open }: { steps: CodexDetails['steps']; open?: boolean }) {
  if (!steps.length) return null
  const start = steps[0].at
  return (
    <Collapsible className="group/steps border-t border-border/60" defaultOpen={open}>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
        <span className="transition-transform group-data-[state=open]/steps:rotate-90">›</span>
        Steps · {steps.length}
        {steps.some((s) => s.status.text === 'failed') && (
          <span className="text-error">
            {steps.filter((s) => s.status.text === 'failed').length} failed
          </span>
        )}
        <span className="ml-auto text-muted-foreground/60">from Codex, untrusted</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2.5 pb-2">
          {steps.map((step, index) => (
            <div className="flex min-w-0 items-baseline gap-2 leading-[1.7]" key={index}>
              <span className="w-5 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                {index + 1}
              </span>
              <Mark status={step.status.text} />
              <span className="min-w-0 flex-1 truncate text-foreground/90" title={step.tool.text}>
                {step.tool.text}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
                +{Math.round((step.at - start) / 1000)}s
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The newest screenshot the result carries, and how many the run saved. Earlier ones are on disk only: the result
 * includes just the last image.
 */
function Shots({ call, saved }: { call: ToolCallView; saved: readonly string[] }) {
  if (!call.images.length && !saved.length) return null
  const folder = saved[0]?.replace(/\/[^/]+$/, '')
  return (
    <ToolSection className="flex gap-3">
      {call.images.slice(-1).map((image, index) => (
        <ToolImage alt="Last screenshot" className="max-w-56 shrink-0" image={image} key={index} />
      ))}
      <div className="flex min-w-0 flex-col gap-0.5 text-[11.5px]">
        <span className="text-foreground/90">
          {call.images.length ? 'last screenshot' : 'no screenshot in the result'}
        </span>
        {saved.length > 0 && (
          <span className="truncate text-muted-foreground/80" title={folder}>
            {plural(saved.length, 'screenshot')} saved privately
          </span>
        )}
      </div>
    </ToolSection>
  )
}

/** Codex's own sandbox requests (commands, file changes, permissions), which are always refused. */
function Refusals({ approvals }: { approvals: CodexDetails['approvals'] }) {
  const refused = approvals.filter((a) => a.kind !== 'elicitation')
  if (!refused.length) return null
  const counts = new Map<string, number>()
  for (const approval of refused) {
    const kind = approval.kind.replace(/^item\//, '').replace(/\/requestApproval$/, '')
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return (
    <ToolSection className="text-[11px] text-muted-foreground">
      refused Codex’s own requests:{' '}
      {[...counts].map(([kind, count]) => `${kind}${count > 1 ? ` ×${count}` : ''}`).join(' · ')}
    </ToolSection>
  )
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 border-t border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground [&>*+*]:before:mr-2 [&>*+*]:before:text-muted-foreground/50 [&>*+*]:before:content-['·']">
      {children}
    </div>
  )
}

export function Operate({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const conversation = useConversation((c) => c.id)
  return <OperateCard call={call} conversation={conversation} duration={duration} />
}

/** The card itself, from the call. */
export function OperateCard({
  call,
  conversation,
  duration,
}: {
  call: ToolCallView
  conversation?: number
  duration?: string
}) {
  const details = detailsOf(call)
  const running = call.status === 'running'
  const live = running ? liveOf(call.output) : undefined
  const status = details?.status
  const [words, tone] = status ? outcomes[status] : ['', 'good' as Tone]
  const resumed = !!text(call.args.session)
  return (
    <Tool defaultOpen>
      <ToolHeader
        action={
          running && conversation !== undefined ? (
            <StopButton conversation={conversation} />
          ) : undefined
        }
        meta={
          <>
            {status && <span className={toneClass[tone]}>{words}</span>}
            {running && live && live.tools > 0 && <span>{plural(live.tools, 'step')}</span>}
            {details && details.steps.length > 0 && (
              <span>{plural(details.steps.length, 'step')}</span>
            )}
            {duration && <span>{duration}</span>}
          </>
        }
        name={resumed ? 'codex · resume' : 'codex'}
        state={
          call.status !== 'done'
            ? call.status
            : tone === 'good'
              ? 'done'
              : tone === 'wait'
                ? 'interrupted'
                : 'error'
        }
        title={text(call.args.brief)}
      />
      <ToolContent>
        {text(call.args.brief) && (
          <ToolSection label="Brief">
            <p className="break-words whitespace-pre-wrap text-muted-foreground">
              {text(call.args.brief)}
            </p>
          </ToolSection>
        )}
        {live && (
          <ToolSection>
            {live.steps.slice(-5).map((step, index, shown) =>
              step.guidance ? (
                <p
                  className="truncate text-foreground/80"
                  data-codex-guidance
                  key={index}
                  title={step.guidance}
                >
                  ↳ {step.guidance}
                </p>
              ) : (
                <div className="flex min-w-0 items-baseline gap-2 leading-[1.7]" key={index}>
                  <span className="w-5 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                    {
                      live.steps
                        .slice(0, live.steps.length - shown.length + index + 1)
                        .filter((s) => s.tool).length
                    }
                  </span>
                  <Mark status={index === shown.length - 1 ? 'running' : 'completed'} />
                  <span className="min-w-0 flex-1 truncate text-foreground/90">{step.tool}</span>
                </div>
              ),
            )}
            {live.message && (
              <p className="truncate text-muted-foreground" title={live.message}>
                “{live.message}”
                <Untrusted />
              </p>
            )}
            <Shimmer className="text-[12px]">
              {live.reconnecting
                ? 'Codex is reconnecting to OpenAI…'
                : live.tools
                  ? 'Codex is working…'
                  : 'starting Codex…'}
            </Shimmer>
          </ToolSection>
        )}
        {status && status !== 'done' && <Problem error={details?.error} status={status} />}
        {details && <Guidance guidance={details.guidance} />}
        {details && <Answer answer={details.answer.text} />}
        {details && <Apps apps={details.apps} />}
        {details && <Shots call={call} saved={details.screenshots} />}
        {details && <Refusals approvals={details.approvals} />}
        {details && (
          <Steps open={status !== 'done' && details.steps.length <= 8} steps={details.steps} />
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      {running && conversation !== undefined && <SteerBox conversation={conversation} />}
      {details && (details.session || details.counts.items > 0) && (
        <Footer>
          <span>steps {details.counts.items}</span>
          {!!details.retries && (
            <span className="text-warning">
              reconnected to OpenAI {details.retries === 1 ? 'once' : `${details.retries}×`}
            </span>
          )}
          {!!details.resumes && (
            <span className="text-warning">
              continued after {plural(details.resumes, 'dropped turn')}
            </span>
          )}
          <span>{details.counts.minutes < 1 ? '<1' : Math.round(details.counts.minutes)} min</span>
          {details.session && (
            <span className="min-w-0 truncate" title={details.session}>
              session {details.session.slice(0, 8)}
            </span>
          )}
        </Footer>
      )}
    </Tool>
  )
}

/** One line for a folded run of work. */
export function Line({ call }: { call: ToolCallView }): ReactNode {
  const brief = text(call.args.brief).split('\n')[0]
  return `codex · ${brief.length > 60 ? `${brief.slice(0, 59)}…` : brief}`
}
