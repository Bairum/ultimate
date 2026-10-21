import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn, useAction, useExtensionUiState, useNow, useUltimate } from '@/sdk'
import { useLive } from './panel.tsx'
import { full, RunIcon, statusLabel, until } from './parts.tsx'
import { ListAction } from './refs.ts'
import type { Automation } from './refs.ts'

const FIRST = 5

/**
 * The Agent sidebar's Scheduled section: enabled automations, soonest first, with their next run and how the last
 * one went; hidden while none is enabled. A row opens its running or failed run's conversation, else the panel.
 */
export function ScheduledSection() {
  const list = useAction(ListAction, null, { onError: () => {} })
  const enabled = (list.data ?? [])
    .filter((automation) => automation.enabled)
    .toSorted((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))
  const soon = enabled.some(
    (automation) =>
      automation.runs.at(-1)?.status === 'running' ||
      (automation.nextAt !== undefined && automation.nextAt - Date.now() < 120000),
  )
  const now = useNow(soon ? 1000 : 15000)
  useLive(
    list.refetch,
    enabled.some((automation) => automation.nextAt !== undefined && now - automation.nextAt > 1500),
    now,
  )
  const [all, setAll] = useState(false)
  const [expanded, setExpanded] = useExtensionUiState('sidebarOpen', true)
  if (enabled.length === 0) return null
  const failing = enabled.filter((automation) => automation.runs.at(-1)?.status === 'failed').length
  return (
    <Collapsible
      aria-label="Scheduled"
      className="mb-1 flex flex-col gap-px border-b border-border/60 pb-1"
      data-sidebar-section="automations"
      onOpenChange={setExpanded}
      open={expanded}
    >
      <CollapsibleTrigger className="group/scheduled mx-2 flex h-6 cursor-pointer items-center gap-1 rounded-md px-1 font-mono text-[9.5px] tracking-wider text-muted-foreground/70 uppercase outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/scheduled:rotate-90" />
        Scheduled
        <span
          className={cn(
            'rounded-full bg-sidebar-accent px-1.5 text-[9.5px] leading-4 tracking-normal tabular-nums',
            failing ? 'text-error' : 'text-foreground/80',
          )}
          title={failing ? `${failing} last run failed` : undefined}
        >
          {enabled.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-px">
        {(all ? enabled : enabled.slice(0, FIRST)).map((automation) => (
          <Row automation={automation} key={automation.id} now={now} />
        ))}
        {enabled.length > FIRST && (
          <button
            className="mx-2 h-5 cursor-pointer rounded-md pl-[26px] text-left font-mono text-[10px] text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setAll(!all)}
            type="button"
          >
            {all ? 'fewer' : `+${enabled.length - FIRST} more`}
          </button>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Row({ automation, now }: { automation: Automation; now: number }) {
  const { openPanel, switchConversation, showSurface } = useUltimate()
  const last = automation.runs.at(-1)
  const running = last?.status === 'running'
  // A run that is going or just failed is what the user wants to see; otherwise the overview.
  const target = last && (running || last.status === 'failed') ? last.conversationId : undefined
  return (
    <button
      className="mx-2 flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md pr-2 pl-2.5 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      data-sidebar-automation={automation.id}
      onClick={() => {
        if (target === undefined) return openPanel('automations')
        showSurface('agent')
        switchConversation(target)
      }}
      title={[
        `${automation.id} · ${automation.name}`,
        automation.nextAt !== undefined && `next ${full(automation.nextAt)}`,
        last && `last run ${statusLabel(last.status)}`,
      ]
        .filter(Boolean)
        .join('\n')}
      type="button"
    >
      <span className="flex size-1.5 shrink-0 items-center justify-center">
        {last ? (
          <RunIcon className="size-2.5" status={last.status} />
        ) : (
          <span className="size-1.5 rounded-full border border-muted-foreground/50" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">
        {automation.name}
      </span>
      <span
        className={cn(
          'shrink-0 font-mono text-[10px] tabular-nums',
          running ? 'text-brand' : 'text-muted-foreground',
        )}
      >
        {running
          ? 'running'
          : automation.nextAt !== undefined
            ? until(automation.nextAt, now)
            : '—'}
      </span>
    </button>
  )
}
