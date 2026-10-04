import { CheckIcon, LoaderCircleIcon, MinusCircleIcon, SkipForwardIcon, XIcon } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import { cn } from '@/sdk'

/** The shapes the server facet's actions return (`server.ts`, which the browser does not import). */
export type Schedule =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'at'; time: string }
  | { kind: 'every'; ms: number }
export interface Run {
  id: string
  firedAt: number
  conversationId?: number
  status: 'running' | 'done' | 'failed' | 'aborted' | 'skipped'
  finishedAt?: number
  answer?: string
}
export interface Automation {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextAt?: number
  runs: Run[]
  agent?: string
}
/** The `describe` action: the schedule parsed, in words, and its next fire times. */
export interface Described {
  schedule: Schedule
  description: string
  next: number[]
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A one-shot schedule whose time has passed: resuming it would fire at once, so its switch stays off. */
export const spent = (automation: Automation, now: number) =>
  automation.schedule.kind === 'at' && Date.parse(automation.schedule.time) <= now

/** `in 3s`, `in 12m`, `in 3h 12m`, `in 2d 4h`, then a short date. */
export function until(at: number, now: number) {
  const seconds = Math.max(0, Math.round((at - now) / 1000))
  if (seconds < 1) return 'now'
  if (seconds < 60) return `in ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  if (days < 7) return `in ${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
  return `on ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/** `now`, `12s ago`, `5m ago`, `3h ago`, `2d ago`, then a short date. */
export function ago(at: number, now: number) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 2) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A clock time, with the date when it is not today: `09:00:03`, `Oct 6, 09:00`. */
export function clock(at: number, now: number) {
  const date = new Date(at)
  return date.toDateString() === new Date(now).toDateString()
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
}

/** The backend's words for a schedule; a one-shot reads as a local time rather than its ISO instant. */
export const words = (schedule: Schedule, description: string, now: number) =>
  schedule.kind === 'at' ? `Once, ${clock(Date.parse(schedule.time), now)}` : description

export const full = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })

const statuses = {
  running: [LoaderCircleIcon, 'animate-spin text-brand', 'running'],
  done: [CheckIcon, 'text-success', 'done'],
  failed: [XIcon, 'text-error', 'failed'],
  aborted: [MinusCircleIcon, 'text-warning', 'stopped'],
  skipped: [SkipForwardIcon, 'text-muted-foreground', 'skipped'],
} as const

export const statusLabel = (status: Run['status']) => statuses[status][2]

export function RunIcon({ status, className }: { status: Run['status']; className?: string }) {
  const [Icon, tone, label] = statuses[status]
  return <Icon aria-label={label} className={cn('size-3 shrink-0', tone, className)} />
}

export function BusyDot({ className }: { className?: string }) {
  return (
    <span className={cn('size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand', className)} />
  )
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 font-mono text-[10px] leading-4 text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** A small uppercase heading with a meta value on the right, as in the Agents and Extensions panels. */
export function Heading({
  children,
  meta,
  className,
}: {
  children: ReactNode
  meta?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase',
        className,
      )}
    >
      {children}
      {meta !== undefined && (
        <span className="ml-auto truncate pl-2 tracking-normal normal-case text-muted-foreground/70">
          {meta}
        </span>
      )}
    </div>
  )
}

/** An on/off switch. While `busy` it ignores presses but keeps focus, which a disabled button would drop. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  busy,
  title,
  ref,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  busy?: boolean
  title?: string
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      aria-busy={busy || undefined}
      aria-checked={checked}
      aria-label={label}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-brand' : 'bg-input',
        busy && 'animate-pulse cursor-progress',
      )}
      disabled={disabled}
      onClick={() => !busy && onChange(!checked)}
      ref={ref}
      role="switch"
      title={title}
      type="button"
    >
      <span
        className={cn(
          'block size-3 rounded-full shadow-sm transition-transform',
          checked
            ? 'translate-x-3.5 bg-brand-foreground'
            : 'translate-x-0.5 bg-muted-foreground/80',
        )}
      />
    </button>
  )
}
