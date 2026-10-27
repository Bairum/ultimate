/**
 * `codex_operate` in the transcript: what Codex was asked, how the run ended, which apps it was let into, its steps and
 * screenshots, and what it says it saw. Everything Codex writes is screen-derived: shown as plain text with the
 * untrusted marker, never as Markdown or our own words.
 */
import { CircleStopIcon, LoaderCircleIcon, MessageCircleQuestionIcon, SendIcon } from 'lucide-react'
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
import { api, cn, errorMessage, useConversation, useDocOf, useToolDuration } from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { SteerAction, StateDoc, StopAction } from './refs.ts'
import type { CodexDetails, CodexState, QuestionEntry } from './refs.ts'

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
 * Progress while a call runs, read from its streamed output: `Step n: <tool>` lines, Codex's own messages, questions
 * and milestones (all inside the untrusted boundary), and our own guidance and answer lines, in the order they happened.
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
      const before = blocks[index - 1] ?? ''
      if (before.endsWith('Codex is reconnecting to OpenAI (')) {
        reconnecting = true
        continue
      }
      reconnecting = false
      if (/Step \d+: $/.test(before)) steps.push({ tool: inner })
      else if (before.endsWith('Codex switched windows: '))
        steps.push({ guidance: `Codex switched windows: ${inner}` })
      else if (before.endsWith('Codex asks: ')) steps.push({ guidance: `Codex asks: ${inner}` })
      else if (before.endsWith('Codex progress: ')) steps.push({ guidance: `Progress: ${inner}` })
      else message = inner
      continue
    }
    for (const line of block.split('\n')) {
      if (
        line.startsWith('Guidance from ') ||
        line.startsWith('Answer from ') ||
        line.startsWith('Connection to OpenAI dropped')
      )
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

type Question = NonNullable<CodexState['question']>

/**
 * "Tell Codex…" under a running call: sends the user's guidance into the active turn. While Codex waits on an
 * ask_operator question it shows that question, and what the user sends is the answer (the first one, from the user or
 * the parent agent, wins).
 */
function SteerBox({ conversation, question }: { conversation: number; question?: Question }) {
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
  const label = question ? 'Answer Codex' : 'Tell Codex'
  return (
    <div
      className={cn('border-t border-border/60 px-2.5 py-1.5', question && 'bg-warning/5')}
      data-codex-question={question ? question.id : undefined}
    >
      {question && (
        <div className="mb-1.5 flex min-w-0 items-start gap-1.5 text-[12px]">
          <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 break-words whitespace-pre-wrap text-foreground/90">
            <span className="text-warning">Codex asks</span> {question.text.text}
            <Untrusted />
          </p>
        </div>
      )}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <input
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          data-codex-steer
          disabled={busy}
          maxLength={4000}
          onChange={(event) => setValue(event.target.value)}
          placeholder={`${label}…`}
          value={value}
        />
        <button
          aria-label={question ? 'Send answer to Codex' : 'Send to Codex'}
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
      {question && (
        <p className="mt-1 text-[10.5px] text-muted-foreground/70">
          The operator's agent is asked too; the first answer goes back. Codex stops and reports
          after 10 minutes without one.
        </p>
      )}
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
          <span className="text-foreground/80">
            {item.from === 'user'
              ? 'You'
              : (item.by?.replace(/^parent conversation /, 'Parent ') ?? 'Operator')}
            :
          </span>{' '}
          {item.text}
          {item.delivery === 'restarted' && (
            <span className="ml-1.5 text-[10.5px] text-warning">
              steer refused, turn restarted with it
            </span>
          )}
          {(item.delivery === 'answered' || item.delivery === 'queued') && (
            <span className="ml-1.5 text-[10.5px] text-muted-foreground/70">
              {item.delivery === 'answered'
                ? "answered Codex's question"
                : 'queued for the next turn'}
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

const resultTone: Record<NonNullable<CodexDetails['result']>['status'], string> = {
  done: 'text-success',
  partial: 'text-warning',
  blocked: 'text-error',
}

/** A labelled list of Codex's own lines (what it changed, what is left). */
function Lines({ label, items }: { label: string; items: { text: string }[] }) {
  if (!items.length) return null
  return (
    <div className="mt-1.5">
      <span className="text-[11px] text-muted-foreground/70">{label}</span>
      {items.map((item, index) => (
        <p className="break-words whitespace-pre-wrap text-foreground/85" key={index}>
          · {item.text}
        </p>
      ))}
    </div>
  )
}

/**
 * Codex's structured result: each finding with the screen text it quotes and the screenshots that show it, then what it
 * changed and what is left. Codex wrote all of it: plain text, never Markdown.
 */
function Findings({ result }: { result: NonNullable<CodexDetails['result']> }) {
  const { findings, actions, remaining } = result
  return (
    <ToolSection label="Findings · from the screen, untrusted">
      <p className="text-[11px]">
        Codex says <span className={resultTone[result.status]}>{result.status}</span>
      </p>
      {findings.length > 0 && (
        <div className="mt-1 divide-y divide-border/50" data-codex-findings>
          {findings.map((finding, index) => (
            <div className="py-1" key={index}>
              <p className="break-words whitespace-pre-wrap text-foreground/90">
                {finding.claim.text}
              </p>
              {finding.quote.text && (
                <p className="mt-0.5 border-l-2 border-l-muted-foreground/30 pl-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
                  “{finding.quote.text}”
                </p>
              )}
              {finding.screenshots.length > 0 && (
                <p
                  className="mt-0.5 truncate text-[11px] text-muted-foreground/70"
                  title={finding.screenshots.join('\n')}
                >
                  {finding.screenshots.map((path) => path.split('/').at(-1)).join(' · ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <Lines items={actions} label="Changed" />
      <Lines items={remaining} label="Left to do" />
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
  const question = useDocOf(conversation, StateDoc)?.question
  return (
    <OperateCard
      call={call}
      conversation={conversation}
      duration={duration}
      {...(question ? { question } : {})}
    />
  )
}

/** The card itself, from the call; `question` is Codex's open ask_operator question, while it waits. */
export function OperateCard({
  call,
  conversation,
  duration,
  question,
}: {
  call: ToolCallView
  conversation?: number
  duration?: string
  question?: Question
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
        {details?.result && <Findings result={details.result} />}
        {details && <Apps apps={details.apps} />}
        {details && <Shots call={call} saved={details.screenshots} />}
        {details && <Refusals approvals={details.approvals} />}
        {details && (
          <Steps open={status !== 'done' && details.steps.length <= 8} steps={details.steps} />
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
      {running && conversation !== undefined && (
        <SteerBox conversation={conversation} {...(question ? { question } : {})} />
      )}
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
          {!!details.windows?.length && (
            <span
              className="text-warning"
              title={details.windows.map((w) => `${w.from.text} → ${w.to.text}`).join('\n')}
            >
              switched windows {details.windows.length}×
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

/**
 * Codex's question in the conversation that owns the operator: the question while it is open, with the same answer
 * box as the running card (the first answer, the user's or this agent's codex_steer, goes back to Codex); once settled,
 * a quiet line.
 */
export function QuestionCard({ entry }: { entry: EntryRecord }) {
  const data = entry.data as QuestionEntry
  const open = useDocOf(data.conversation, StateDoc)?.question
  const waiting = open?.id === data.question && open.text.text === data.text
  return (
    <div
      className="my-1 overflow-hidden rounded-md border border-border/70 bg-card text-[12px]"
      data-codex-question-card
    >
      <div className="flex min-w-0 items-start gap-1.5 px-2.5 py-1.5">
        <MessageCircleQuestionIcon
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            waiting ? 'text-warning' : 'text-muted-foreground',
          )}
        />
        <p className="min-w-0 flex-1 break-words whitespace-pre-wrap text-foreground/90">
          <span className={waiting ? 'text-warning' : 'text-muted-foreground'}>
            Codex in #{data.conversation} {waiting ? 'asks' : 'asked'}
          </span>{' '}
          {data.text}
          <Untrusted />
        </p>
        {!waiting && <span className="shrink-0 text-muted-foreground/70">settled</span>}
      </div>
      {waiting && <SteerBox conversation={data.conversation} question={open} />}
    </div>
  )
}

/** One line for a folded run of work. */
export function Line({ call }: { call: ToolCallView }): ReactNode {
  const brief = text(call.args.brief).split('\n')[0]
  return `codex · ${brief.length > 60 ? `${brief.slice(0, 59)}…` : brief}`
}
