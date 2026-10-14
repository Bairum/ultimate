import { cn } from '@/sdk'
import { useWorkspaceIndex } from '../workspaces/data.tsx'

/** `now`, `5m`, `3h`, `2d`, then a short date. */
export function ago(at: number, now: number) {
  const minutes = Math.max(0, (now - at) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.floor(minutes)}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / 60 / 24)}d`
  const date = new Date(at)
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === new Date(now).getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', year: '2-digit' },
  )
}

/**
 * The lander's line: "fixing" or "diagnosing" while its model works on a failure, a pulsing "landing" while it lands,
 * "working" while it answers someone, else "idle" with its latest landing.
 */
export function LanderState({
  id,
  index,
  now,
  working,
}: {
  id: number
  index: ReturnType<typeof useWorkspaceIndex>
  now: number
  working: boolean
}) {
  const source = Object.entries(index.landerConversations).find(([, lander]) => lander === id)?.[0]
  const current = index.queue.find((item) => item.source === source && item.state === 'landing')
  const label =
    current?.agent === 'fix'
      ? 'fixing'
      : current?.agent
        ? 'diagnosing'
        : current
          ? 'landing'
          : working
            ? 'working'
            : undefined
  if (label)
    return (
      <span className={cn('flex items-center gap-1', label !== 'diagnosing' && 'text-brand')}>
        <span
          className={cn(
            'size-1.5 animate-pulse-dot rounded-full',
            label === 'diagnosing' ? 'bg-muted-foreground' : 'bg-brand',
          )}
        />
        {label}
      </span>
    )
  const last = Object.values(index.results).findLast((result) => result.lander === id && result.sha)
  const at = last?.steps.at(-1)?.at
  return (
    <span className="truncate" title={at ? new Date(at).toLocaleString() : undefined}>
      idle{last?.sha && ` · last ${last.sha.slice(0, 7)}${at ? ` ${ago(at, now)}` : ''}`}
    </span>
  )
}
