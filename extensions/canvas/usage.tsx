import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatTokens, useModels } from '@/sdk'
import type { Totals } from './data.tsx'
import { useTotals } from './data.tsx'
import type { CanvasUsage } from './types.ts'

/** The model's context window, from the model list, as the status line looks it up. */
function useWindow(usage: CanvasUsage | undefined) {
  const models = useModels()
  return models?.models.find(
    (model) => model.provider === usage?.provider && model.id === usage.model,
  )?.contextWindow
}

/** How full the context is, in percent; undefined while unknown. */
function percentOf(usage: CanvasUsage | undefined, window: number | undefined) {
  return usage?.context === undefined || !window ? undefined : (usage.context / window) * 100
}

const cost = (value: number) => `$${value.toFixed(value < 0.1 ? 3 : 2)}`
/** `↑26k ↓1.7k · $0.50`; nothing before any spend. */
const spend = (totals: Pick<Totals, 'input' | 'output' | 'cost'>) =>
  totals.input || totals.output
    ? `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)} · ${cost(totals.cost)}`
    : ''

/** A thin bar of how full the context is: warning above 70 %, error above 90 %, as in the status line. */
export function ContextBar({ usage, className }: { usage?: CanvasUsage; className?: string }) {
  const percent = percentOf(usage, useWindow(usage))
  return (
    <span
      className={cn('relative block overflow-hidden rounded-full bg-muted', className)}
      data-context={percent === undefined ? '' : percent.toFixed(1)}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 rounded-full transition-[width] duration-700',
          percent !== undefined && percent > 90
            ? 'bg-error'
            : percent !== undefined && percent > 70
              ? 'bg-warning'
              : 'bg-brand/60',
        )}
        style={{ width: `${Math.min(100, percent ?? 0)}%` }}
      />
    </span>
  )
}

/**
 * `42% of 272k · ↑26k ↓1.7k · $0.50 · gpt-6-astra`: its own context, and the spend of `members` (a whole tree)
 * when given, else its own.
 */
export function UsageLine({
  usage,
  members,
}: {
  usage?: CanvasUsage
  members?: readonly number[]
}) {
  const window = useWindow(usage)
  const tree = useTotals(members ?? [])
  const percent = percentOf(usage, window)
  const many = members !== undefined && members.length > 1
  const parts = [
    percent !== undefined && window ? `${Math.round(percent)}% of ${formatTokens(window)}` : '',
    (many ? 'tree ' : '') + spend(many ? tree : (usage ?? tree)),
    usage?.model ?? '',
  ].filter((part) => part && part !== 'tree ')
  if (!parts.length) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex h-4 shrink-0 items-center gap-2 font-mono text-[10.5px] text-muted-foreground"
          data-usage
        >
          <ContextBar className="h-1 w-10 shrink-0" usage={usage} />
          <span className="truncate">{parts.join(' · ')}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        {many
          ? `Its own context; tokens and cost of it and its ${members.length - 1} subagent${members.length === 2 ? '' : 's'}`
          : 'Context, then tokens in and out and cost'}
      </TooltipContent>
    </Tooltip>
  )
}

/** Every number, for focus mode: the context in tokens, input, output, cache reads, cost, the model; tree totals. */
export function UsageDetails({
  usage,
  members,
}: {
  usage?: CanvasUsage
  members?: readonly number[]
}) {
  const window = useWindow(usage)
  const tree = useTotals(members ?? [])
  const percent = percentOf(usage, window)
  if (!usage) return null
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border/50 px-4 py-1.5 font-mono text-[11px] text-muted-foreground"
      data-usage
    >
      <span className="flex items-center gap-1.5">
        <ContextBar className="h-1.5 w-14" usage={usage} />
        {usage.context === undefined
          ? 'context unknown until the next answer'
          : `${usage.context.toLocaleString()}${window ? ` of ${window.toLocaleString()} (${percent!.toFixed(1)}%)` : ''} in context`}
      </span>
      <span>↑{usage.input.toLocaleString()} in</span>
      <span>↓{usage.output.toLocaleString()} out</span>
      <span>R{usage.cacheRead.toLocaleString()} cache read</span>
      <span className="text-foreground/80">${usage.cost.toFixed(4)}</span>
      {usage.model && (
        <span>
          {usage.provider}/{usage.model}
        </span>
      )}
      {members && members.length > 1 && (
        <span>
          tree of {members.length}: ↑{formatTokens(tree.input)} ↓{formatTokens(tree.output)} R
          {formatTokens(tree.cacheRead)} {cost(tree.cost)}
        </span>
      )}
    </div>
  )
}

/** The hub's line: what everything on the map spent. */
export function HubTotals({ ids }: { ids: readonly number[] }) {
  const totals = useTotals(ids)
  if (!ids.length) return null
  return (
    <span className="truncate font-mono text-[11px] text-muted-foreground" data-hub-totals>
      {totals.agents} agent{totals.agents === 1 ? '' : 's'}
      {spend(totals) && ` · ${spend(totals)}`}
    </span>
  )
}
