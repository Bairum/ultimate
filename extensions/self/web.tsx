import { ChevronRightIcon, RotateCwIcon, TriangleAlertIcon, ZapIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  cn,
  defineWebExtension,
  formatTime,
  useConversation,
  useRestart,
  useSystem,
  useToolDuration,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'

const short = (id: string | undefined) => id?.slice(0, 7)

interface RestartDetails {
  fromGeneration?: number
  toGeneration?: number
  fromBuild?: string
  toBuild?: string
  refused?: boolean
  rolledBack?: boolean
  error?: string
}

/**
 * The `restart` tool: the swap's generations and builds from its `details`, or the boot error that kept the old core
 * serving. A record without details reads as a plain core swap.
 */
function RestartCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const result = (call.details ?? {}) as RestartDetails
  const failed = call.status === 'error'
  const generations =
    result.fromGeneration !== undefined
      ? `gen ${result.fromGeneration} → ${result.toGeneration}`
      : `gen → ${result.toGeneration}`
  const builds =
    result.fromBuild && result.toBuild && result.fromBuild === result.toBuild ? (
      ' · same build'
    ) : result.fromBuild && result.toBuild ? (
      <>
        {' '}
        · build {short(result.fromBuild)} →{' '}
        <span className="text-foreground/85">{short(result.toBuild)}</span>
      </>
    ) : null
  const title: ReactNode =
    call.status === 'done' && result.toGeneration !== undefined ? (
      <>
        <span className="text-success">swapped</span> · {generations}
        {builds}
      </>
    ) : failed && result.refused ? (
      <span className="text-error">restart refused · shared host unchanged</span>
    ) : failed && result.rolledBack ? (
      <span className="text-error">
        activation failed · rolled back to gen {result.toGeneration ?? result.fromGeneration}
      </span>
    ) : failed ? (
      <span className="text-error">boot failed · the old core kept serving</span>
    ) : call.status === 'running' || call.status === 'pending' ? (
      'type-checking and booting a new core…'
    ) : call.status === 'interrupted' ? (
      'interrupted'
    ) : (
      'core swap'
    )
  const error = result.error ?? (failed ? call.output : undefined)
  return (
    <Tool defaultOpen={failed}>
      <ToolHeader meta={duration} name="restart" state={call.status} title={title} />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">
              blue/green swap: type-check, boot, hand over storage, resume this run…
            </Shimmer>
          </ToolSection>
        )}
        {error ? (
          <ToolOutput isError output={error} />
        ) : (
          call.output && <ToolSection className="text-muted-foreground">{call.output}</ToolSection>
        )}
      </ToolContent>
    </Tool>
  )
}

/** A status-line item next to the generation while `server/` or `shared/` changed since this core booted. */
function CoreStale() {
  const system = useSystem()
  const restart = useRestart()
  if (restart.error)
    return (
      <Popover onOpenChange={(open) => !open && restart.clear()}>
        <PopoverTrigger asChild>
          <button
            className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-error transition-colors hover:bg-accent"
            type="button"
          >
            <TriangleAlertIcon className="size-3" />
            restart failed
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[32rem] p-0 font-mono" side="top">
          <div className="border-b border-border/70 px-3 py-2 text-[11.5px] text-muted-foreground">
            The shared Ultimate host restart did not take.
          </div>
          <pre className="max-h-80 overflow-auto px-3 py-2 text-[11.5px] leading-[1.55] whitespace-pre-wrap text-error">
            {restart.error}
          </pre>
          <div className="flex justify-end gap-2 border-t border-border/70 px-3 py-2">
            <Button className="h-7 text-[12px]" onClick={restart.clear} size="sm" variant="ghost">
              Dismiss
            </Button>
            <Button
              className="h-7 text-[12px]"
              onClick={() => {
                restart.clear()
                restart.run()
              }}
              size="sm"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    )
  if (!system?.code.coreStale && !restart.busy) return null
  // A phone's status line has room for the action only.
  const stale = (
    <span>
      <span className="max-md:hidden">core changed · </span>restart
    </span>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors',
            restart.busy ? 'text-brand' : 'text-warning hover:bg-accent',
          )}
          disabled={restart.busy}
          onClick={restart.run}
          type="button"
        >
          <RotateCwIcon className={cn('size-3', restart.busy && 'animate-spin')} />
          {restart.pending !== undefined
            ? `swapping to gen ${restart.pending}…`
            : restart.busy
              ? 'checking…'
              : stale}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 font-mono text-[11px]" side="top">
        server/ or shared/ changed since generation {system?.process.generation} booted. Restart
        type-checks and boots a new core next to this one; if it fails, this one keeps serving.
      </TooltipContent>
    </Tooltip>
  )
}

/** `build a1b2c3d` in the status line; it lights up when the build changes. */
function Build() {
  const system = useSystem()
  const id = system?.build.id
  const [fresh, setFresh] = useState(false)
  const last = useRef(id)
  useEffect(() => {
    if (!id || last.current === id) return undefined
    const first = last.current === undefined
    last.current = id
    if (first) return undefined
    setFresh(true)
    const timer = setTimeout(() => setFresh(false), 4000)
    return () => clearTimeout(timer)
  }, [id])
  if (!system) return null
  const { build } = system
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'transition-colors duration-700',
            fresh ? 'text-brand' : 'text-muted-foreground/80',
          )}
        >
          build {short(build.id)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[28rem] font-mono text-[11px]" side="top">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
          <span className="opacity-60">build</span>
          <span>
            {build.id} · gen {build.generation}
          </span>
          <span className="opacity-60">core</span>
          <span>{build.core.slice(0, 12)}</span>
          {Object.entries(build.extensions).map(([name, hash]) => (
            <span className="contents" key={name}>
              <span className="opacity-60">{name}</span>
              <span>{hash.slice(0, 12)}</span>
            </span>
          ))}
        </div>
        {build.history.length > 1 && (
          <div className="mt-2 border-t border-current/20 pt-1.5">
            {build.history
              .toReversed()
              .slice(0, 8)
              .map((entry) => (
                <div className="flex gap-2" key={`${entry.id}-${entry.at}`}>
                  <span className="opacity-60">{formatTime(entry.at, true)}</span>
                  <span>{short(entry.id)}</span>
                  <span className="truncate opacity-80">
                    {entry.changed.length ? entry.changed.join(', ') : `gen ${entry.generation}`}
                  </span>
                </div>
              ))}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** How long the hot-reload toast stays after the last update. */
const hotLifetime = 3000

/** `extensions/lineage/web.tsx?t=1` as `lineage/web.tsx`: enough to recognise the file. */
const hotFile = (path: string) => path.split('?')[0].split('/').slice(-2).join('/')

/**
 * A quiet toast above the bottom right of the status line when Vite applies a hot update without reloading the page:
 * the modules it re-ran (its accept boundaries, not necessarily the edited file). Updates arriving meanwhile join it
 * and keep it up.
 */
function HotReloaded() {
  const [files, setFiles] = useState<readonly string[]>([])
  useEffect(() => {
    const hot = import.meta.hot
    if (!hot) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const updated = ({ updates }: { updates: { acceptedPath: string }[] }) => {
      // Vite's own virtual modules mean nothing to a reader.
      const paths = updates
        .map((update) => update.acceptedPath)
        .filter((path) => !path.startsWith('/@id/'))
      if (paths.length === 0) return
      setFiles((shown) => [...new Set([...shown, ...paths.map(hotFile)])])
      clearTimeout(timer)
      timer = setTimeout(() => setFiles([]), hotLifetime)
    }
    hot.on('vite:afterUpdate', updated)
    return () => {
      hot.off('vite:afterUpdate', updated)
      clearTimeout(timer)
    }
  }, [])
  if (files.length === 0) return null
  // Tailwind rebuilds its stylesheet on every source change: name it only when nothing else changed.
  const scripts = files.filter((file) => !file.endsWith('.css'))
  const named = scripts.length > 0 ? scripts : files
  return (
    <div
      className="pointer-events-none fixed right-3 bottom-9 z-40 flex max-w-96 animate-in items-center gap-1.5 rounded-md border border-border/80 bg-popover px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground shadow-lg fade-in-0 slide-in-from-bottom-1"
      role="status"
    >
      <ZapIcon className="size-3.5 shrink-0 text-brand" />
      <span className="shrink-0 text-foreground/90">Hot reloaded</span>
      <span className="truncate">{named.slice(0, 2).join(', ')}</span>
      {named.length > 2 && <span className="shrink-0">+{named.length - 2}</span>}
    </div>
  )
}

interface BuildLine {
  id: string
  generation?: number
  changed: string[]
}
/** The prompt's build section: `Ultimate build <id> · generation <n> …` and `Changed in this build: …`. */
function parseBuild(section: string | null | undefined): BuildLine | undefined {
  if (typeof section !== 'string') return undefined
  const id = /Ultimate build (\w+)/.exec(section)?.[1]
  if (!id) return undefined
  const generation = /generation (\d+)/.exec(section)?.[1]
  const changed = /Changed in this build: (.+)/.exec(section)?.[1]
  return {
    id,
    generation: generation === undefined ? undefined : Number(generation),
    changed: changed ? changed.split(',').map((item) => item.trim()) : [],
  }
}
const systemOf = (entry: EntryRecord | undefined) => {
  const message = entry?.model?.[0]
  return entry?.kind === 'pi.system' && message?.role === 'system' ? message : undefined
}

/** A core restart that kept the same code: only the generation in the build section changed. */
function Restarted({ from, to }: { from: number; to: number }) {
  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/60 before:h-px before:flex-1 before:bg-border/50 after:h-px after:flex-1 after:bg-border/50">
      <span className="flex items-center gap-1.5">
        <RotateCwIcon className="size-3" />
        Restarted · gen {from} → {to} · same build
      </span>
    </div>
  )
}

/**
 * A `pi.system` entry that changes the build section is a hot reload: show it as one marker with what changed. A
 * remove-all entry that Pi Durable writes right before a reordered re-add belongs to that marker and shows nothing.
 */
// Pi upstream: @earendil-works/pi-durable@1.3.0 src/harness/prompt.ts — internal remove-all pi.system entry immediately precedes a reordered re-add, hidden here. Drop when Pi exposes prompt reorder metadata instead of requiring entry-sequence inference.
function SystemEntry({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const entries = useConversation((conversation) => conversation.entries)
  const system = useSystem()
  const message = systemOf(entry)
  if (!message?.sections) return core
  const index = entries.findIndex((candidate) => candidate.id === entry.id)
  const values = Object.values(message.sections)
  if (values.length > 0 && values.every((value) => value === null) && systemOf(entries[index + 1]))
    return null
  const current = parseBuild(message.sections.build)
  let previous: BuildLine | undefined
  for (let at = index - 1; at >= 0 && !previous; at--)
    previous = parseBuild(systemOf(entries[at])?.sections?.build)
  if (!current || !previous) return core
  if (previous.id === current.id)
    return previous.generation !== undefined &&
      current.generation !== undefined &&
      previous.generation !== current.generation ? (
      <Restarted from={previous.generation} to={current.generation} />
    ) : (
      core
    )
  // Builds the conversation did not see in between still count: union their changes from the history.
  const history = system?.build.history ?? []
  const from = history.findIndex((item) => item.id === previous.id)
  const to = history.findIndex((item) => item.id === current.id)
  // When the previous build fell out of the history (20 builds), everything kept since is a lower bound: mark it "…".
  const since = to >= 0 && from < to ? history.slice(from + 1, to + 1) : undefined
  const changed = since
    ? [...new Set(since.flatMap((item) => item.changed))].toSorted()
    : current.changed
  const partial = since !== undefined && from < 0
  const sections = Object.entries(message.sections).filter(([, value]) => value !== null)
  const added = message.toolsAdded?.map((tool) => tool.name) ?? []
  const removed = message.toolsRemoved?.map((tool) => tool.name) ?? []
  return (
    <Collapsible className="group/reload">
      <CollapsibleTrigger className="w-full">
        <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground/80 before:h-px before:flex-1 before:bg-brand/25 after:h-px after:flex-1 after:bg-brand/25 hover:text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]/reload:rotate-90" />
            <RotateCwIcon className="size-3 shrink-0 text-brand" />
            <span className="text-brand">Reloaded</span>
            <span className="truncate">
              · build {short(previous.id)} →{' '}
              <span className="text-foreground/80">{short(current.id)}</span>
              {previous.generation !== undefined &&
                current.generation !== undefined &&
                previous.generation !== current.generation &&
                ` · gen ${previous.generation} → ${current.generation}`}
              {changed.length > 0 && ` · changed: ${changed.join(', ')}${partial ? ', …' : ''}`}
            </span>
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 rounded-md border border-border/70 bg-card/40 px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
        <div className="mb-1 text-foreground/80">The agent's prompt and tools changed here:</div>
        {sections.map(([key, value]) => (
          <div className="flex gap-3" key={key}>
            <span className="w-32 shrink-0 text-foreground/80">{key}</span>
            <span className="truncate">{(value ?? '').length.toLocaleString()} chars</span>
          </div>
        ))}
        {(added.length > 0 || removed.length > 0) && (
          <div className="flex gap-3">
            <span className="w-32 shrink-0 text-foreground/80">tools</span>
            <span className="min-w-0 break-words">
              {added.length > 0 && `re-declared ${added.join(' ')}`}
              {removed.filter((name) => !added.includes(name)).length > 0 &&
                ` · removed ${removed.filter((name) => !added.includes(name)).join(' ')}`}
            </span>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export default defineWebExtension({
  tools: { restart: RestartCall },
  entries: { 'pi.system': SystemEntry },
  slots: {
    // Discovery order puts `self` before `status-line`: the item sits just left of `live · gen N`.
    'statusline.right': [CoreStale, { component: Build, order: 1 }],
    overlay: HotReloaded,
  },
})
