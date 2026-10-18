import { CheckIcon, LoaderCircleIcon, MinusCircleIcon, SkipForwardIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn, formatTime } from '@/sdk'
import type { Automation, Run, Schedule } from './refs.ts'

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
    ? formatTime(date, true)
    : date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
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
