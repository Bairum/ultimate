/**
 * A supervised practice run of a saved lesson: a ladder of its steps with each before/after check, the final recheck,
 * and, when a check fails, the mismatch: what the lesson expected against what OCR saw, both frames, and Reopen
 * lesson to fix. It renders under `computer_teach practice` and `check` calls and in the teaching document view, from
 * `ComputerDetails.teach` (`teachDetails`): every screen string is `UntrustedText`, shown quoted and plain.
 */
import { CheckIcon, CircleDashedIcon, CircleDotIcon, ImageOffIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn, formatTime } from '@/sdk'
import { TeachReopenAction } from './refs.ts'
import type { ComputerDetails, FrameRef, UntrustedText } from './refs.ts'
import { ScreenMark } from './shared.tsx'
import { TeachButton } from './teach-live.tsx'

export type TeachDetails = NonNullable<ComputerDetails['teach']>
type Practice = NonNullable<TeachDetails['practice']>
type Mismatch = NonNullable<TeachDetails['mismatches']>[number]
type Check = Practice['checks'][number]

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** A frame the server names but no route serves yet: its size and id, never the picture. */
function FrameSlot({ label, frame, tone }: { label: string; frame?: FrameRef; tone?: string }) {
  return (
    <figure
      className="min-w-0 flex-1 overflow-hidden rounded-sm border border-border/70 bg-background/50 text-[10.5px]"
      data-practice-frame={label}
    >
      <figcaption className={cn('border-b border-border/60 bg-muted/40 px-1.5 py-1', tone)}>
        {label}
      </figcaption>
      <div className="flex items-center gap-1.5 px-1.5 py-1.5 text-muted-foreground tabular-nums">
        <ImageOffIcon className="size-3 shrink-0 text-muted-foreground/60" />
        {frame ? (
          <span className="min-w-0 truncate" title={frame.id}>
            {frame.width}×{frame.height}
            {!frame.file && <span className="text-muted-foreground/60"> · image not kept</span>}
          </span>
        ) : (
          <span>no frame</span>
        )}
      </div>
    </figure>
  )
}

function Quoted({ items }: { items: readonly UntrustedText[] }) {
  if (!items.length) return <span className="text-muted-foreground">nothing</span>
  return (
    <>
      {items.map((item, index) => (
        <span key={index}>
          {index > 0 && <span className="text-muted-foreground/50"> · </span>}“{item.text}”
        </span>
      ))}
      <ScreenMark />
    </>
  )
}

/** One phase of a step: passed ✓ with its time, failed ✗, running ●, or not yet. */
function Phase({
  name,
  check,
  failed,
  current,
}: {
  name: string
  check?: Check
  failed: boolean
  current: boolean
}) {
  return (
    <span
      className={cn(
        'flex items-center gap-1',
        check
          ? 'text-success'
          : failed
            ? 'text-error'
            : current
              ? 'text-brand'
              : 'text-muted-foreground/60',
      )}
      title={check ? `checked ${formatTime(check.at, true)}` : undefined}
    >
      {check ? (
        <CheckIcon className="size-3" />
      ) : failed ? (
        <XIcon className="size-3" />
      ) : current ? (
        <CircleDotIcon className="size-3 animate-pulse-dot" />
      ) : (
        <CircleDashedIcon className="size-3" />
      )}
      {name}
    </span>
  )
}

/** Where a run stands: which step is next, how many have both checks, and whether it stopped. */
export function progress(teach: TeachDetails) {
  const practice = teach.practice
  const total = teach.steps.length
  const checks = practice?.checks ?? []
  const done = teach.steps.filter(
    (s) =>
      checks.some((c) => c.step === s.n && c.phase === 'before') &&
      checks.some((c) => c.step === s.n && c.phase === 'after'),
  ).length
  const mismatch = teach.mismatches?.at(-1)
  const next = mismatch ? mismatch.step : Math.min(total, done + 1)
  return { total, done, next, mismatch, finished: !!practice?.final }
}

/**
 * What the lesson expected, by role. A before check expected the target label then its anchors; an after check's
 * entries carry the server's `Appears: `/`Disappears: ` prefix, which is ours, not screen text.
 */
function expectations(mismatch: Mismatch): [string, UntrustedText[]][] {
  if (mismatch.phase === 'before') {
    const [target, ...anchors] = mismatch.expected
    return [
      ['expected', target ? [target] : []],
      ...(anchors.length ? [['near it', anchors] as [string, UntrustedText[]]] : []),
    ]
  }
  const strip = (prefix: string) =>
    mismatch.expected
      .filter((e) => e.text.startsWith(prefix))
      .map((e) => ({ ...e, text: e.text.slice(prefix.length) }))
  const appears = strip('Appears: ')
  const gone = strip('Disappears: ')
  return [
    ...(appears.length ? [['should appear', appears] as [string, UntrustedText[]]] : []),
    ...(gone.length ? [['should go away', gone] as [string, UntrustedText[]]] : []),
  ]
}

/** The mismatch that stopped the run, prominent: the step, expected against seen, both frames, and how to fix it. */
function MismatchBlock({
  mismatch,
  label,
  practice,
  conversation,
}: {
  mismatch: Mismatch
  label?: UntrustedText
  practice: Practice
  conversation?: number
}) {
  const [error, setError] = useState<string>()
  const [reopened, setReopened] = useState(false)
  return (
    <div
      className="space-y-2 border-t border-error/30 bg-error/[0.06] px-3 py-2.5"
      data-practice-mismatch
    >
      <p className="font-sans text-[13px] leading-snug">
        <span className="text-error">Stopped at step {mismatch.step}</span>
        <span className="text-muted-foreground">
          {' '}
          · the screen {mismatch.phase === 'before' ? 'before' : 'after'} the step did not match the
          lesson
        </span>
      </p>
      {label && (
        <p className="font-mono text-[11.5px] text-muted-foreground">
          step {mismatch.step}: “{label.text}”
          <ScreenMark />
        </p>
      )}
      <div className="space-y-1 font-mono text-[11.5px] leading-[1.6]">
        {expectations(mismatch).map(([role, items]) => (
          <div className="flex min-w-0 gap-2" key={role}>
            <span className="w-24 shrink-0 text-muted-foreground">{role}</span>
            <span className="min-w-0 flex-1 break-words text-foreground">
              <Quoted items={items} />
            </span>
          </div>
        ))}
        <div className="flex min-w-0 gap-2">
          <span className="w-24 shrink-0 text-muted-foreground">OCR saw</span>
          <span className="min-w-0 flex-1 break-words text-foreground/80">
            <Quoted items={mismatch.seen.slice(0, 12)} />
            {mismatch.seen.length > 12 && (
              <span className="text-muted-foreground/60"> · +{mismatch.seen.length - 12} more</span>
            )}
          </span>
        </div>
      </div>
      <div className="flex gap-2 font-mono max-sm:flex-col">
        <FrameSlot frame={mismatch.taught} label="taught screen" />
        <FrameSlot
          frame={mismatch.fresh}
          label={`screen now · ${formatTime(mismatch.at, true)}`}
          tone="text-error"
        />
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Nothing else is sent in this run. Reopen the lesson to fix the step, approve every step
        again and save; then start a new practice.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {conversation !== undefined && !reopened && (
          <ReopenButton
            conversation={conversation}
            name={practice.skill}
            onDone={() => setReopened(true)}
            onError={setError}
            scope={practice.scope}
          />
        )}
        {reopened && (
          <span className="font-mono text-[11.5px] text-success">Reopened for review below.</span>
        )}
        <span className="font-mono text-[11px] text-muted-foreground">
          {practice.scope}/{practice.skill}
        </span>
      </div>
      {error && (
        <p className="font-mono text-[11.5px] break-words text-error">{reopenWords(error)}</p>
      )}
    </div>
  )
}

/** Reopen failures in the user's words. */
const reopenWords = (error: string) =>
  error.includes('Save or reject the current draft')
    ? 'A draft is still open in this conversation. Save or discard it first, then reopen.'
    : error.includes('Finish the practice')
      ? 'This practice is still running. The agent must finish it as partial or blocked first.'
      : error.includes('Stop teaching')
        ? 'A recording is running. Stop it first.'
        : error.includes('busy')
          ? 'The agent is operating the computer right now. Try again when it stops.'
          : error

function ReopenButton({
  conversation,
  scope,
  name,
  onError,
  onDone,
}: {
  conversation: number
  scope: 'project' | 'personal'
  name: string
  onError: (message: string | undefined) => void
  onDone: () => void
}) {
  return (
    <span data-practice-reopen>
      <TeachButton
        action={TeachReopenAction}
        args={{ conversation, scope, name }}
        onError={onError}
        onSuccess={onDone}
        tone="primary"
      >
        Reopen lesson to fix
      </TeachButton>
    </span>
  )
}

/**
 * The practice run as a step ladder. `teach` is a call's `details.teach`; the live document's practice is mapped to
 * the same shape by the caller.
 */
export function PracticeRun({
  teach,
  conversation,
  header,
  pending,
}: {
  teach: TeachDetails
  conversation?: number
  header?: ReactNode
  /** The run waits for the user to confirm its task: nothing is checked or sent yet. */
  pending?: boolean
}) {
  const practice = teach.practice
  if (!practice) return null
  const { total, done, next: upcoming, mismatch, finished } = progress(teach)
  const next = pending ? 0 : upcoming
  const tone = mismatch
    ? 'border-l-error/70'
    : finished
      ? 'border-l-success/60'
      : pending
        ? 'border-l-warning/70'
        : 'border-l-brand/50'
  return (
    <section
      className={cn('min-w-0 rounded-md border border-border border-l-2 bg-muted/20', tone)}
      data-practice={mismatch ? 'mismatch' : finished ? 'done' : pending ? 'pending' : 'running'}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {header}
        <span className="text-foreground">Practice</span>
        <span className="min-w-0 truncate font-sans text-[12px] text-foreground/90">
          “{practice.title.text}”
        </span>
        <span
          className={cn(
            'ml-auto tabular-nums',
            mismatch
              ? 'text-error'
              : finished
                ? 'text-success'
                : pending
                  ? 'text-warning'
                  : 'text-brand',
          )}
        >
          {mismatch
            ? `stopped at step ${mismatch.step} of ${total}`
            : finished
              ? `all ${total} steps matched`
              : pending
                ? `${plural(total, 'step')} · waits for you`
                : `step ${next} of ${total}`}
        </span>
      </header>
      <p className="px-3 pt-2 font-mono text-[11px] text-muted-foreground">
        “{practice.app.text}”
        {practice.window.titleSubstring.text
          ? ` · window “${practice.window.titleSubstring.text}”`
          : ` · window ${practice.window.id}`}
        <ScreenMark /> · {practice.scope}/{practice.skill} · {done}/{plural(total, 'step')} checked
      </p>
      <ol className="space-y-0.5 px-3 py-2" data-practice-ladder>
        {teach.steps.map((step) => {
          const before = practice.checks.find((c) => c.step === step.n && c.phase === 'before')
          const after = practice.checks.find((c) => c.step === step.n && c.phase === 'after')
          const failed = mismatch?.step === step.n
          const current = !mismatch && !finished && step.n === next
          const later = (mismatch ? step.n > mismatch.step : pending || step.n > next) && !before
          return (
            <li
              className={cn(
                'flex min-w-0 items-baseline gap-2 rounded-sm px-1 py-0.5 font-mono text-[12px] leading-5',
                failed && 'bg-error/10',
                current && 'bg-brand/10',
                later && 'opacity-55',
              )}
              data-practice-step={
                failed ? 'mismatch' : after ? 'done' : current ? 'current' : 'later'
              }
              key={step.n}
            >
              <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                {step.n}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">{step.action}</span> “{step.label.text}”
                {step.consequential && (
                  <span className="ml-1.5 text-[10.5px] text-warning">consequential</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2.5 text-[11px]">
                <Phase
                  check={before}
                  current={current && !before}
                  failed={failed && mismatch?.phase === 'before'}
                  name="before"
                />
                <Phase
                  check={after}
                  current={current && !!before}
                  failed={failed && mismatch?.phase === 'after'}
                  name="after"
                />
              </span>
            </li>
          )
        })}
      </ol>
      {mismatch && (
        <MismatchBlock
          conversation={conversation}
          label={teach.steps.find((s) => s.n === mismatch.step)?.label}
          mismatch={mismatch}
          practice={practice}
        />
      )}
      {finished && !mismatch && (
        <div className="flex gap-2 border-t border-border/60 px-3 py-2.5 font-mono max-sm:flex-col">
          <div className="min-w-0 flex-1 space-y-1 text-[11.5px] leading-[1.6]">
            <p className="text-success">Every step matched its lesson, before and after.</p>
            <p className="text-muted-foreground">
              The last step was checked again on a fresh screen.
            </p>
          </div>
          <div className="w-44 max-sm:w-full">
            <FrameSlot frame={practice.final} label="final screen" tone="text-success" />
          </div>
        </div>
      )}
      {!finished && !mismatch && (
        <p className="border-t border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {pending
            ? 'Confirm the task above to start. Nothing is checked or sent until then.'
            : 'Each step: check the screen, one action, check the result. Any mismatch stops the run.'}
        </p>
      )}
    </section>
  )
}
