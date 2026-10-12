import { Handle, Position, useStore as useFlow } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  BotIcon,
  BracesIcon,
  CameraIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  EllipsisIcon,
  EraserIcon,
  FilePenIcon,
  FilePlus2Icon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  ListTodoIcon,
  Maximize2Icon,
  PencilIcon,
  SignpostIcon,
  SquareIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { createContext, memo, useContext, useLayoutEffect, useRef, useState } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Conversation, api, cn, formatKeys } from '@/sdk'
import { useAgentFeed } from './data.tsx'
import type { Agent, Status } from './model.tsx'
import { STATUS, activityOf, isActive, nameOf, reasonTip } from './model.tsx'
import type { CanvasAgent, CanvasEdit, CanvasTool } from './types.ts'
import { ContextBar, UsageDetails, UsageLine } from './usage.tsx'

/** Below this zoom panels are far cards: big title, state colour, one line. */
export const FAR = 0.6

/** What panels can do on the map; the map provides it. */
export type CanvasActions = {
  /** Zoom the agent's panel to fill the view, with its transcript and composer. */
  open: (id: number) => void
  back: () => void
  rename: (id: number | undefined) => void
  archive: (id: number, archived: boolean) => void
  clear: (id: number) => void
  workspace: (id: number) => void
}
export const CanvasContext = createContext<{
  actions: CanvasActions
  /** Rename, clear and archive go through the `conversations` extension. */
  conversations: boolean
} | null>(null)
const useCanvas = () => useContext(CanvasContext)!

export type PanelData = {
  agent: Agent
  /** The shown conversation. */
  selected: boolean
  /** Zoomed to fill the view, with the real transcript and composer. */
  focused: boolean
  /** A card or pill under the pointer, opened to a full panel above its neighbours. */
  expanded: boolean
  renaming: boolean
  /** When it first appeared on the map (ms); zero for panels there from the start. */
  born: number
}
export type PanelNode = Node<PanelData, 'agent'>

/** Springs the element in once, when it mounts within a second and a half of `born`. */
function useSpawn(born: number) {
  const element = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!born || Date.now() - born > 1500) return
    element.current?.animate(
      [
        { transform: 'scale(0.3)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      { duration: 650, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
    )
    // Only on mount: a panel that re-renders while it is new does not spring again.
  }, [])
  return element
}

const icons: Record<string, ComponentType<{ className?: string }>> = {
  read: FileTextIcon,
  edit: FilePenIcon,
  write: FilePlus2Icon,
  bash: TerminalIcon,
  subagent: BotIcon,
  codemode: BracesIcon,
  browser: GlobeIcon,
  screenshot: CameraIcon,
  plan: ListTodoIcon,
  workspace: GitBranchIcon,
}

/** The state's mark: a pulsing dot while it works, an icon once it settled. */
function Mark({ status, className }: { status: Status; className?: string }) {
  const style = STATUS[status]
  const Icon = {
    decision: SignpostIcon,
    done: CircleCheckIcon,
    replied: CheckIcon,
    failed: CircleAlertIcon,
    queued: ClockIcon,
  }[status as string]
  return Icon ? (
    <Icon className={cn('size-3.5 shrink-0', style.text, className)} />
  ) : (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        style.fill,
        (status === 'working' || status === 'waiting') && 'animate-pulse-dot',
        className,
      )}
    />
  )
}

function Tip({ tip, children }: { tip?: string; children: ReactNode }) {
  if (!tip) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-72">{tip}</TooltipContent>
    </Tooltip>
  )
}

function StateLabel({ status, className }: { status: Status; className?: string }) {
  const style = STATUS[status]
  return (
    <Tip tip={style.tip}>
      <span className={cn('shrink-0 whitespace-nowrap', style.text, className)}>{style.label}</span>
    </Tip>
  )
}

/** Why it waits for a decision, in the warm colour of needs-input. */
function Reasons({ reasons, className }: { reasons: readonly string[]; className?: string }) {
  return reasons.map((reason) => (
    <Tip key={reason} tip={reasonTip(reason)}>
      <span
        className={cn(
          'shrink-0 rounded-sm bg-warning/12 px-1 whitespace-nowrap text-warning',
          className,
        )}
        data-reason={reason}
      >
        {reason}
      </span>
    </Tip>
  ))
}

/** `W<id>`: the agent works in its own checkout; a click opens the Workspaces panel on it. */
function WorkspaceBadge({ agent }: { agent: Agent }) {
  const { actions } = useCanvas()
  if (!agent.workspace) return null
  return (
    <button
      className="nodrag shrink-0 cursor-pointer rounded-sm px-1 font-mono text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation()
        actions.workspace(agent.id)
      }}
      title={`Isolated checkout (${agent.workspace.state}${agent.workspace.landed ? ', landed' : ''}): workspace details`}
      type="button"
    >
      W{agent.id}
    </button>
  )
}

function Title({
  agent,
  renaming,
  className,
}: {
  agent: Agent
  renaming?: boolean
  className?: string
}) {
  const { actions } = useCanvas()
  const { summary } = agent
  const cancelled = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  // Without scrolling: the map's container would scroll under its viewport.
  useLayoutEffect(() => {
    if (renaming) input.current?.focus({ preventScroll: true })
  }, [renaming])
  if (renaming)
    return (
      <input
        aria-label="Conversation title"
        className="nodrag h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
        defaultValue={summary.title ?? ''}
        onBlur={(event) => {
          actions.rename(undefined)
          if (cancelled.current) return
          void api.action('conversations', 'rename', {
            id: agent.id,
            title: event.currentTarget.value.trim(),
          })
        }}
        onFocus={(event) => {
          cancelled.current = false
          event.currentTarget.select()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            cancelled.current = true
            event.currentTarget.blur()
          }
        }}
        ref={input}
      />
    )
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5', className)}>
      {summary.label && (
        <span className="shrink-0 font-mono text-[0.85em] text-brand">{summary.label}</span>
      )}
      <span className="truncate font-medium" title={nameOf(summary)}>
        {nameOf(summary)}
      </span>
    </span>
  )
}

/** The panel's menu: what the sidebar row and the agent view offered, for this agent. */
function Menu({ agent }: { agent: Agent }) {
  const { actions, conversations } = useCanvas()
  const top = agent.parent === undefined
  const busy = isActive(agent.status)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Agent actions"
        className="nodrag flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <EllipsisIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // The menu renders in a portal, but React bubbles its clicks to the node, which would select it again.
        onClick={(event) => event.stopPropagation()}
        className="w-48 [&_[role=menuitem]]:cursor-pointer [&_[role=menuitem]]:text-[12.5px]"
      >
        <DropdownMenuItem onSelect={() => actions.open(agent.id)}>
          <Maximize2Icon />
          Open
        </DropdownMenuItem>
        {busy && (
          <DropdownMenuItem onSelect={() => void api.abort(agent.id)}>
            <SquareIcon />
            Stop the run
          </DropdownMenuItem>
        )}
        {agent.workspace && (
          <DropdownMenuItem onSelect={() => actions.workspace(agent.id)}>
            <GitBranchIcon />
            Workspace details
          </DropdownMenuItem>
        )}
        {top && conversations && (
          <>
            <div className="my-1 border-t border-border" role="separator" />
            <DropdownMenuItem onSelect={() => actions.rename(agent.id)}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => actions.clear(agent.id)}>
              <EraserIcon />
              Clear context…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.archive(agent.id, !agent.archived)}>
              {agent.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {agent.archived ? 'Unarchive' : 'Archive'}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The latest calls as chips, newest last; new ones slide in, running ones shimmer. */
function Chips({ tools }: { tools: readonly CanvasTool[] }) {
  const seen = useRef<Set<string>>(null)
  seen.current ??= new Set(tools.map((tool) => tool.id))
  return (
    <div className="flex h-6 items-center gap-1 overflow-hidden">
      {tools.slice(-6).map((tool) => {
        const Icon = icons[tool.name] ?? WrenchIcon
        // A subagent call names the agent it starts (`start scout: …`), else its action.
        const name =
          tool.name === 'bash'
            ? '$'
            : tool.name === 'subagent'
              ? (/^start (\S+):/.exec(tool.label)?.[1] ?? tool.label.split(' ')[0])
              : tool.name
        return (
          <span
            className={cn(
              'flex h-5.5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px]',
              tool.status === 'running'
                ? 'border-brand/50 bg-brand/10 text-foreground'
                : tool.status === 'error'
                  ? 'border-error/40 bg-error/10 text-error'
                  : 'border-border bg-muted/60 text-muted-foreground',
            )}
            data-tool={tool.name}
            data-tool-status={tool.status}
            key={tool.id}
            ref={(element) => {
              if (!element || seen.current!.has(tool.id)) return
              seen.current!.add(tool.id)
              element.animate(
                [
                  { transform: 'translateX(14px)', opacity: 0 },
                  { transform: 'none', opacity: 1 },
                ],
                { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
              )
            }}
            title={tool.label}
          >
            <Icon className="size-3" />
            {tool.status === 'running' ? <Shimmer>{name}</Shimmer> : name}
          </span>
        )
      })}
    </div>
  )
}

/** Markdown markers make a tail noisy; panels show plain words. */
const plain = (text: string) =>
  text
    .replace(/```\w*/g, ' ')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The end of a text: the newest words stay in view; when it does not fit, older ones fade out at the top. */
function Tail({ text, thinking }: { text: string; thinking?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const element = box.current!
    setClipped(element.scrollHeight > element.clientHeight + 1)
  }, [text])
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col justify-end overflow-hidden',
        clipped && '[mask-image:linear-gradient(to_bottom,transparent,black_1.6em)]',
      )}
      data-tail={thinking ? 'thinking' : 'writing'}
      ref={box}
    >
      <p
        className={cn(
          'break-words',
          thinking
            ? 'text-[12px] leading-snug text-muted-foreground/80 italic'
            : 'text-[13px] leading-relaxed text-foreground/90',
        )}
      >
        {plain(text)}
      </p>
    </div>
  )
}

function Edits({ edits }: { edits: readonly CanvasEdit[] }) {
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11px]">
      {edits.slice(-2).map((edit, index) => (
        // Two edits of one file in a tool round share their time.
        <span className="flex min-w-0 items-center gap-2" key={index}>
          <span className="truncate text-foreground/75" title={edit.path}>
            {edit.path}
          </span>
          <span className="shrink-0 text-diff-add">+{edit.added}</span>
          <span className="shrink-0 text-diff-del">−{edit.removed}</span>
        </span>
      ))}
    </div>
  )
}

function Header({ agent, renaming }: { agent: Agent; renaming: boolean }) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-2 text-[13px]">
      <Mark status={agent.status} />
      <Title agent={agent} className="flex-1" renaming={renaming} />
      <WorkspaceBadge agent={agent} />
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">#{agent.id}</span>
      <Menu agent={agent} />
    </div>
  )
}

/** The condensed panel: state, the latest calls, the thinking or writing tail, the latest edits, or the summary. */
function Mid({ agent, feed, renaming }: { agent: Agent; feed?: CanvasAgent; renaming: boolean }) {
  const active = agent.status === 'working' || agent.status === 'waiting'
  const latest = feed?.tools.findLast((tool) => tool.status === 'running') ?? feed?.tools.at(-1)
  const thinking =
    active && feed?.thinking && feed.thinking.at > (feed.writing?.at ?? 0)
      ? feed.thinking
      : undefined
  const writing = active ? feed?.writing : undefined
  const waiting = agent.status === 'waiting' ? feed?.waitingOn : undefined
  // Idle: Luna's summary (or what the subagent did), then the end of the last answer, which a decision needs.
  const summary =
    agent.parent === undefined ? (agent.row?.summary ?? agent.row?.activity) : agent.row?.activity
  return (
    <>
      <Header agent={agent} renaming={renaming} />
      <div className="flex h-4.5 shrink-0 items-center gap-1.5 overflow-hidden pl-4 text-[11px]">
        <StateLabel status={agent.status} />
        {waiting && (
          <span className="truncate font-mono text-muted-foreground">
            on {waiting.map((id) => `#${id}`).join(', ')}
          </span>
        )}
        <Reasons reasons={agent.reasons} />
        {agent.archived && <span className="text-muted-foreground">· archived</span>}
      </div>
      {latest && (
        <div className="mt-2 shrink-0">
          <Chips tools={feed!.tools} />
          <p
            className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
            title={latest.label}
          >
            {latest.label}
          </p>
        </div>
      )}
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1.5">
        {thinking ? (
          <Tail text={thinking.text} thinking />
        ) : writing ? (
          <Tail text={writing.text} />
        ) : summary && feed?.writing ? (
          <>
            <p
              className="line-clamp-2 shrink-0 text-[12px] leading-snug text-muted-foreground"
              data-summary
            >
              {summary}
            </p>
            <Tail text={feed.writing.text} />
          </>
        ) : (
          <p
            className="line-clamp-4 text-[12.5px] leading-relaxed text-muted-foreground"
            data-summary
          >
            {activityOf(agent, feed)}
          </p>
        )}
      </div>
      {feed && feed.edits.length > 0 && (
        <div className="mt-2 shrink-0 border-t border-border/60 pt-1.5">
          <Edits edits={feed.edits} />
        </div>
      )}
      <div className="mt-1.5 shrink-0">
        <UsageLine
          members={agent.parent === undefined ? agent.members : undefined}
          usage={feed?.usage}
        />
      </div>
    </>
  )
}

/** The far card: readable from afar, so few and big. */
function Far({ agent, feed }: { agent: Agent; feed?: CanvasAgent }) {
  if (agent.shape === 'card')
    return (
      <>
        <div className="flex shrink-0 items-center gap-3 text-[20px]">
          <Mark className="size-5" status={agent.status} />
          <StateLabel status={agent.status} />
          <span className="ml-auto font-mono text-muted-foreground/70">#{agent.id}</span>
        </div>
        <p className="mt-1 shrink-0 truncate text-[30px] leading-tight font-medium">
          {nameOf(agent.summary)}
        </p>
        <ContextBar className="mt-auto h-2.5 w-full shrink-0" usage={feed?.usage} />
      </>
    )
  if (agent.shape === 'pill')
    return (
      <>
        <p className="flex items-center gap-3 truncate text-[26px]">
          <Mark className="size-5" status={agent.status} />
          <span className="font-mono text-brand">{agent.summary.label ?? 'agent'}</span>
          <span className="text-muted-foreground">#{agent.id}</span>
        </p>
        <ContextBar className="absolute inset-x-8 bottom-1.5 h-1.5" usage={feed?.usage} />
      </>
    )
  return (
    <>
      <div className="flex shrink-0 items-center gap-3 text-[24px]">
        <Mark className="size-5" status={agent.status} />
        <StateLabel status={agent.status} />
        <span className="ml-auto font-mono text-[20px] text-muted-foreground/70">#{agent.id}</span>
      </div>
      <p className="mt-2 line-clamp-2 shrink-0 text-[34px] leading-tight font-medium break-words">
        {agent.summary.label && (
          <span className="mr-2 font-mono text-brand">{agent.summary.label}</span>
        )}
        {nameOf(agent.summary)}
      </p>
      <p className="mt-auto shrink-0 truncate text-[22px] text-muted-foreground">
        {agent.reasons.length ? agent.reasons.join(' · ') : activityOf(agent, feed)}
      </p>
      <ContextBar className="mt-3 h-2.5 w-full shrink-0" usage={feed?.usage} />
    </>
  )
}

/**
 * A concluded conversation folded with everything it owns: its title, state and Luna summary. `conclusion` is the
 * place for a richer outcome (commits, what landed, a screenshot), rendered under the summary once something provides
 * it.
 */
export function ConclusionCard({
  agent,
  feed,
  renaming,
  conclusion,
}: {
  agent: Agent
  feed?: CanvasAgent
  renaming: boolean
  conclusion?: ReactNode
}) {
  return (
    <>
      <Header agent={agent} renaming={renaming} />
      <div className="flex h-4.5 shrink-0 items-center gap-1.5 pl-4 text-[11px] text-muted-foreground">
        <StateLabel status={agent.status} />
        {agent.folded > 0 && (
          <span>
            · {agent.folded} subagent{agent.folded === 1 ? '' : 's'}
          </span>
        )}
        {agent.archived && <span>· archived</span>}
      </div>
      <p
        className="mt-1.5 line-clamp-3 pl-4 text-[12px] leading-snug text-muted-foreground"
        data-summary
      >
        {agent.row?.summary ?? agent.row?.activity ?? 'No summary yet'}
      </p>
      {conclusion && <div className="mt-2 pl-4">{conclusion}</div>}
      <div className="mt-auto pl-4">
        <UsageLine members={agent.members} usage={feed?.usage} />
      </div>
    </>
  )
}

/** A finished subagent: its colour, label, and what it did, in one line. */
function Pill({ agent, feed }: { agent: Agent; feed?: CanvasAgent }) {
  return (
    <>
      <div className="flex h-5 items-center gap-1.5 text-[11.5px]">
        <Mark status={agent.status} />
        <span className="truncate font-mono text-foreground/85">
          {agent.summary.label ?? 'agent'} · #{agent.id}
        </span>
        <StateLabel className="ml-auto text-[10.5px]" status={agent.status} />
      </div>
      <p className="truncate pl-3.5 text-[11.5px] text-muted-foreground" data-summary>
        {activityOf(agent, feed)}
      </p>
      <ContextBar className="absolute inset-x-4 bottom-1 h-0.5" usage={feed?.usage} />
    </>
  )
}

/** Zoomed in to fill the view: the real transcript and composer, scrolling and typing as on the Agent surface. */
function Focused({ agent, feed }: { agent: Agent; feed?: CanvasAgent }) {
  const { actions } = useCanvas()
  const summary = agent.parent === undefined ? agent.row?.summary : agent.row?.activity
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-[13px]">
        <button
          aria-label="Back to the map"
          className="nodrag flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={actions.back}
          type="button"
        >
          <ArrowLeftIcon className="size-3.5" />
          Map
          {/* While it works, Escape stops the run, as in the agent view. */}
          {!isActive(agent.status) && <Kbd>{formatKeys('escape')[0].join(' ')}</Kbd>}
        </button>
        <Mark status={agent.status} />
        <Title agent={agent} className="flex-1" />
        <Reasons className="text-[11px]" reasons={agent.reasons} />
        <StateLabel className="text-[12px]" status={agent.status} />
        <WorkspaceBadge agent={agent} />
        <span className="font-mono text-[11px] text-muted-foreground/70">#{agent.id}</span>
        <Menu agent={agent} />
      </div>
      {(summary || agent.row?.summaryStatus === 'pending') && (
        <p
          className="shrink-0 truncate border-b border-border/50 px-4 py-1.5 text-[12px] text-muted-foreground"
          data-summary
          title={summary}
        >
          {summary ?? 'Updating summary…'}
        </p>
      )}
      <UsageDetails
        members={agent.parent === undefined ? agent.members : undefined}
        usage={feed?.usage}
      />
      <div
        className="nodrag nowheel nopan flex min-h-0 flex-1 cursor-auto flex-col select-text"
        data-canvas-focus
      >
        <Conversation variant="dock" />
      </div>
    </>
  )
}

/** One agent on the map; its detail follows its shape and the zoom. */
export const AgentPanel = memo(function AgentPanel({ data }: NodeProps<PanelNode>) {
  const { agent, selected, focused, expanded, renaming, born } = data
  const feed = useAgentFeed(agent.id)
  const far = useFlow((state) => state.transform[2] < FAR) && !focused && !expanded
  const style = STATUS[agent.status]
  const active = agent.status === 'working' || agent.status === 'waiting'
  const shape = focused || expanded ? 'panel' : agent.shape
  const card = useSpawn(born)
  return (
    <div
      className={cn(
        'relative flex size-full flex-col bg-card text-card-foreground transition-[border-color,box-shadow,opacity] duration-500',
        focused
          ? 'rounded-xl border border-border shadow-2xl'
          : far
            ? cn(
                'border-4',
                shape === 'pill'
                  ? 'justify-center rounded-full px-8'
                  : shape === 'card'
                    ? 'rounded-3xl p-5'
                    : 'rounded-3xl p-6',
              )
            : shape === 'pill'
              ? 'justify-center rounded-2xl border-2 px-3'
              : 'rounded-xl border-2 px-3.5 py-3',
        !focused && style.border,
        expanded && 'shadow-2xl',
        selected && !focused && 'ring-2 ring-foreground/20 ring-offset-4 ring-offset-background',
        agent.status === 'working' && !focused && 'shadow-[0_0_32px_-10px_var(--color-brand)]',
        agent.status === 'waiting' && !focused && 'shadow-[0_0_32px_-10px_var(--color-sky-400)]',
        agent.status === 'decision' &&
          !focused &&
          'bg-[color-mix(in_oklab,var(--color-warning)_6%,var(--color-card))]',
        agent.archived && !focused && !expanded && 'opacity-60',
      )}
      data-agent={agent.id}
      data-shape={shape}
      data-status={agent.status}
      ref={card}
    >
      {active && !focused && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute animate-pulse border-2',
            far ? '-inset-3 rounded-[2rem]' : '-inset-1.5 rounded-[1rem]',
            agent.status === 'waiting'
              ? 'border-sky-500/45 dark:border-sky-400/45'
              : 'border-brand/40',
          )}
        />
      )}
      <Handle className="opacity-0" isConnectable={false} position={Position.Top} type="target" />
      {focused ? (
        <Focused agent={agent} feed={feed} />
      ) : far ? (
        <Far agent={agent} feed={feed} />
      ) : shape === 'card' ? (
        <ConclusionCard agent={agent} feed={feed} renaming={renaming} />
      ) : shape === 'pill' ? (
        <Pill agent={agent} feed={feed} />
      ) : (
        <Mid agent={agent} feed={feed} renaming={renaming} />
      )}
      <Handle
        className="opacity-0"
        isConnectable={false}
        position={Position.Bottom}
        type="source"
      />
    </div>
  )
})
