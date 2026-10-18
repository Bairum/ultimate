import { cn } from 'cn'
import { CheckIcon, CircleIcon, LoaderCircleIcon, MinusIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/sdk'
import type { Transition, TransitionStep } from '../../cloud/protocol.ts'

const labels: Record<TransitionStep['name'], string> = {
  fetch: 'update checkout',
  install: 'install dependencies',
  checks: 'checks',
  handover: 'handover',
  download: 'download snapshot',
  branches: 'restore branches',
  claim: 'claim',
}

/** Running, ended with an error, or done: the target runs the project. */
export function phaseOf(transition: Transition): 'running' | 'failed' | 'done' {
  if (transition.error) return 'failed'
  return transition.steps.find((step) => step.name === 'claim')?.state === 'done'
    ? 'done'
    : 'running'
}

/** A failed checks step that only lacked secrets, which a forced move continues past. */
export const forceable = (transition: Transition) =>
  !!transition.error?.startsWith('Missing secrets:') &&
  transition.steps.some((step) => step.name === 'checks' && step.state === 'failed')

/**
 * "Preparing rog", "Handing over: haza-pc finishing 2 runs", "Running on rog", or what failed. On the machine the
 * project leaves (`source`): "Handing over to rog…", "Handing over to rog: finishing 2 runs".
 */
function title(transition: Transition, source: boolean) {
  const phase = phaseOf(transition)
  if (phase === 'failed') return `Moving to ${transition.target} failed`
  if (phase === 'done') return `Running on ${transition.target}`
  const handover = transition.steps.find((step) => step.name === 'handover')
  const draining = transition.step === 'handover' && handover?.state === 'running'
  if (source)
    return draining && handover.detail
      ? `Handing over to ${transition.target}: ${handover.detail}`
      : `Handing over to ${transition.target}…`
  if (draining && transition.from)
    return `Handing over: ${transition.from} ${handover.detail ?? 'releasing'}`
  return `Preparing ${transition.target}`
}

const mb = (bytes: number) => {
  const value = bytes / 1024 / 1024
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

function StepIcon({ state }: { state: TransitionStep['state'] }) {
  if (state === 'running')
    return <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-brand" />
  if (state === 'done') return <CheckIcon className="size-3 shrink-0 text-success/70" />
  if (state === 'failed') return <XIcon className="size-3 shrink-0 text-error" />
  if (state === 'skipped') return <MinusIcon className="size-3 shrink-0 text-muted-foreground/50" />
  return <CircleIcon className="size-2 shrink-0 text-muted-foreground/40" />
}

function Step({ step }: { step: TransitionStep }) {
  const sized = step.name === 'download' && step.total !== undefined && step.total > 0
  return (
    <li className="space-y-1">
      <div
        className={cn(
          'flex min-w-0 items-center gap-2 leading-5',
          step.state === 'running' ? 'text-brand' : 'text-muted-foreground',
          step.state === 'pending' && 'text-muted-foreground/60',
        )}
      >
        <span className="flex w-3 shrink-0 justify-center">
          <StepIcon state={step.state} />
        </span>
        <span className="shrink-0">{labels[step.name]}</span>
        {step.detail && step.state !== 'failed' && (
          <span className="min-w-0 truncate text-muted-foreground/60" title={step.detail}>
            · {step.detail}
          </span>
        )}
        {sized && (
          <span className="ml-auto shrink-0 tabular-nums">
            {mb(step.done ?? 0)} / {mb(step.total!)} MB
          </span>
        )}
      </div>
      {sized && step.state === 'running' && (
        <div className="ml-5 h-0.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-brand/70 transition-[width]"
            style={{ width: `${Math.min(100, ((step.done ?? 0) / step.total!) * 100)}%` }}
          />
        </div>
      )}
    </li>
  )
}

const tones = {
  running: 'border-l-brand/70',
  failed: 'border-l-error/70',
  done: 'border-l-success/70',
}

/**
 * A move of the project to another machine as one card: its title by phase, one line per step, and what can be done
 * about it. `onCancel` stops it while it can be stopped, `onForce` continues past missing secrets, `onDismiss` hides an
 * ended one. Each may be missing where this page cannot do it. `compact` shows only the current step; `source` titles
 * it for the machine the project leaves.
 */
export function TransitionCard({
  transition,
  onCancel,
  onForce,
  onDismiss,
  compact,
  source = false,
  className,
}: {
  transition: Transition
  onCancel?: () => Promise<unknown>
  onForce?: () => Promise<unknown>
  onDismiss?: () => void
  compact?: boolean
  source?: boolean
  className?: string
}) {
  const phase = phaseOf(transition)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const act = (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    action()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }
  return (
    <section
      className={cn(
        'min-w-0 rounded-md border border-l-2 border-border bg-card text-left font-mono text-[11.5px] shadow-xs',
        tones[phase],
        className,
      )}
      data-transition={phase}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 py-1.5 pr-1.5 pl-3">
        {phase === 'running' ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-brand" />
        ) : phase === 'done' ? (
          <CheckIcon className="size-3.5 shrink-0 text-success" />
        ) : (
          <XIcon className="size-3.5 shrink-0 text-error" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          {title(transition, source)}
        </span>
        {phase === 'running' && transition.cancellable && onCancel && (
          <Button
            className="h-5 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={() => act(onCancel)}
            size="xs"
            variant="ghost"
          >
            Cancel
          </Button>
        )}
        {phase !== 'running' && onDismiss && (
          <Button
            aria-label="Dismiss"
            className="size-5 text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
            size="icon-xs"
            title="Dismiss"
            variant="ghost"
          >
            <XIcon />
          </Button>
        )}
      </header>
      <div className="space-y-1.5 px-3 py-2">
        <ol className="space-y-0.5">
          {transition.steps
            .filter((step) => !compact || step.name === transition.step)
            .map((step) => (
              <Step key={step.name} step={step} />
            ))}
        </ol>
        {transition.error && (
          <p className="font-sans text-[12px] leading-relaxed break-words whitespace-pre-wrap text-error/90">
            {transition.error}
          </p>
        )}
        {phase === 'failed' && forceable(transition) && onForce && (
          <Button
            className="h-6 font-sans text-[12px]"
            disabled={busy}
            onClick={() => act(onForce)}
            size="xs"
            variant="outline"
          >
            Continue anyway
          </Button>
        )}
        {error && <p className="font-sans text-[12px] text-error">{error}</p>}
      </div>
    </section>
  )
}
