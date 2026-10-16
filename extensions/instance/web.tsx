import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  cn,
  defineWebExtension,
  shortenPath,
  useAction,
  useConversations,
  useStore,
  useSystem,
  useToolDuration,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'

interface Instance {
  id: string
  url: string
  home: string
  pid: number
}

function result(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    return undefined
  }
}

/** One instance: its URL as a link, pid, home, and id. */
function Card({ instance, status }: { instance: Instance; status: string }) {
  const system = useSystem()
  return (
    <div className="flex flex-col gap-0.5 rounded-sm border border-border/70 bg-terminal px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-success" />
        <a
          className="flex items-center gap-1 text-brand hover:underline"
          href={instance.url}
          rel="noreferrer"
          target="_blank"
        >
          {instance.url}
          <ExternalLinkIcon className="size-3" />
        </a>
        <span className="text-muted-foreground/70">{status}</span>
        <span className="ml-auto text-[11px] text-muted-foreground/70">pid {instance.pid}</span>
      </div>
      <div className="flex gap-3 text-[11px] text-muted-foreground/70">
        <span className="truncate" title={instance.home}>
          home {shortenPath(instance.home, { home: system?.machine.home })}
        </span>
        <span className="ml-auto shrink-0" title={instance.id}>
          {instance.id.slice(0, 8)}
        </span>
      </div>
    </div>
  )
}

function InstanceCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const action = typeof call.args.action === 'string' ? call.args.action : 'start'
  const id = typeof call.args.id === 'string' ? call.args.id : undefined
  const done = call.status === 'done'
  const value = done ? result(call.output) : undefined
  const started =
    action === 'start' && value && typeof value === 'object' && 'url' in value
      ? (value as Instance)
      : undefined
  const title =
    action === 'start'
      ? `start${call.args.faux === true ? ' · faux' : ''}${started ? ` · ${started.url}` : ''}`
      : `${action}${id ? ` ${id.slice(0, 8)}` : ''}`
  return (
    <Tool defaultOpen={action !== 'logs' || call.status === 'error'}>
      <ToolHeader meta={duration} name="instance" state={call.status} title={title} />
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">
              {action === 'start' ? 'booting a second Ultimate…' : `${action}…`}
            </Shimmer>
          </ToolSection>
        )}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        {started && (
          <ToolSection>
            <Card instance={started} status="started" />
          </ToolSection>
        )}
        {done && action === 'list' && Array.isArray(value) && (
          <ToolSection label={`${value.length} running`}>
            <div className="flex flex-col gap-1.5">
              {(value as Instance[]).map((instance) => (
                <Card instance={instance} key={instance.id} status="running" />
              ))}
            </div>
          </ToolSection>
        )}
        {done && action === 'stop' && (
          <ToolSection className="text-muted-foreground">stopped</ToolSection>
        )}
        {done && action === 'logs' && typeof value === 'string' && (
          <Collapsible className="group/logs" defaultOpen>
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[10px] tracking-wider text-muted-foreground/80 uppercase hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/logs:rotate-90" />
              Logs
              <span className="tracking-normal normal-case text-muted-foreground/60">
                {value.split('\n').length} lines
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="max-h-80 overflow-auto bg-terminal px-3 py-2 leading-[1.55] whitespace-pre-wrap text-foreground/85">
                {value}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </ToolContent>
    </Tool>
  )
}

/** What the `list` action returns. */
interface Preview {
  id: string
  url: string
  conversationId: number
  faux: boolean
}

/** Previews bind to loopback, so a page opened from elsewhere, such as the tailnet, cannot show them. */
const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(location.hostname)

/** The preview shown below the title bar, in memory: a reload returns to this project. */
let shown: Preview | undefined
const listeners = new Set<() => void>()
function show(preview: Preview | undefined) {
  shown = preview
  for (const listener of listeners) listener()
}
const useShown = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => shown,
  )

const port = (url: string) => `:${new URL(url).port}`

/**
 * Switches between this project and the previews `instance` runs, after the project name in the title bar. Hidden
 * while there are none; it asks every 5 s, and when the menu opens.
 */
function Switcher() {
  const current = useShown()
  const conversations = useConversations()
  const { data, refetch } = useAction<Preview[]>('instance', 'list', null, {
    // A failed poll leaves the last list; the next one tries again.
    onError: () => {},
  })
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 5000)
    return () => clearInterval(timer)
  }, [refetch])
  useEffect(() => {
    if (current && data && !data.some((preview) => preview.id === current.id)) show(undefined)
  }, [current, data])
  if (!data?.length) return null
  const title = (preview: Preview) =>
    conversations.find((conversation) => conversation.id === preview.conversationId)?.title
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => open && void refetch()}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
            current && 'bg-brand/10 text-foreground',
          )}
          title="Switch instance"
          type="button"
        >
          {current ? (
            <>
              <span className="size-1.5 rounded-full bg-brand" />#{current.conversationId}
              {current.faux && ' · faux'} · {port(current.url)}
            </>
          ) : (
            `${data.length} ${data.length === 1 ? 'preview' : 'previews'}`
          )}
          <ChevronDownIcon className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80" sideOffset={4}>
        <DropdownMenuLabel className="px-2 pt-1 pb-1.5 font-mono text-[10.5px] font-normal tracking-wider text-muted-foreground uppercase">
          Instances
        </DropdownMenuLabel>
        <DropdownMenuItem className="gap-2 py-1.5" onSelect={() => show(undefined)}>
          <span className={cn('flex-1 text-[13px]', !current && 'text-brand')}>This project</span>
          <span className="font-mono text-[11px] text-muted-foreground">{port(location.href)}</span>
        </DropdownMenuItem>
        {data.map((preview) => (
          <DropdownMenuItem
            className="gap-2 py-1.5"
            data-instance={preview.id}
            key={preview.id}
            onSelect={() => show(preview)}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px]',
                current?.id === preview.id && 'text-brand',
              )}
            >
              #{preview.conversationId}
              {title(preview) && <span className="text-muted-foreground"> {title(preview)}</span>}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {preview.faux && 'faux · '}
              {port(preview.url)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The shown preview's whole UI, below the title bar and above the surfaces. Showing another surface of this project
 * returns to it.
 */
function Embedded() {
  const current = useShown()
  const surface = useStore((state) => state.ui.surface?.id)
  useEffect(() => () => show(undefined), [surface])
  if (!current) return null
  return (
    <div className="fixed inset-x-0 top-7 bottom-0 z-40 bg-background">
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- a whole Ultimate on its own origin, trusted as in its own tab */}
      <iframe
        allow="clipboard-read; clipboard-write"
        className="size-full border-0"
        key={current.id}
        src={current.url}
        title={`Preview #${current.conversationId}`}
      />
    </div>
  )
}

export default defineWebExtension({
  tools: { instance: InstanceCall },
  slots: { 'titlebar.left': loopback ? [Switcher] : [], overlay: [Embedded] },
})
