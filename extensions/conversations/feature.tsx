import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import { useEffect, useState } from 'react'
import { cn } from '@/sdk'
import type { OverviewState } from './types.ts'

const overviewKind = 'ultimate.conversation-overview'

/** One root stream for all rows, unchanged when selection or expansion changes. */
export function useOverview() {
  const [overview, setOverview] = useState<OverviewState | null>()
  useEffect(() => {
    const stream = new EventSource(`/api/events?conversation=1&docs=${overviewKind}`)
    stream.addEventListener('doc', (event) => {
      const data = JSON.parse(event.data) as { kind: string; value: OverviewState | null }
      if (data.kind === overviewKind) setOverview(data.value)
    })
    stream.addEventListener('docOps', (event) => {
      const data = JSON.parse(event.data) as { kind: string; ops: Op[] }
      if (data.kind === overviewKind)
        setOverview((previous) => (previous ? applyImmutable(previous, data.ops) : previous))
    })
    return () => stream.close()
  }, [])
  return overview?.conversations ?? {}
}

const hues = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
]

export function FeatureTag({ feature, className }: { feature: string; className?: string }) {
  let hash = 0
  for (const char of feature) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return (
    <span
      className={cn(
        'min-w-0 truncate rounded px-1.5 font-sans text-[10px] leading-4',
        hues[(hash >>> 0) % hues.length],
        className,
      )}
      data-feature={feature}
      title={feature}
    >
      {feature}
    </span>
  )
}
