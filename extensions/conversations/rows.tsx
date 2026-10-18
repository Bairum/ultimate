import {
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  EllipsisIcon,
  FoldVerticalIcon,
  MessageCircleIcon,
  PencilIcon,
  ScrollTextIcon,
  StickyNoteIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, cn, events, formatTokens, useAction, useDocOf, useUltimate } from '@/sdk'
import type { RootEvent } from '../lineage/types.ts'
import { FeatureTag } from './feature.tsx'
import { TaskChip, useTaskOf } from '../plan/chip.tsx'
import { PhaseLabel, usePhase } from '../phase/chip.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/data.tsx'
import type { Assessment, OverviewRow } from './types.ts'
import { ago } from './lander.tsx'
import { AgentMark, agentTitle } from './marks.tsx'
import type { Presence } from './marks.tsx'

export function currentAssessment(row: OverviewRow | undefined) {
  return row?.runState === 'answered' &&
    row.assessment?.answerId === row.answerId &&
    row.assessment?.inputId === row.inputId
    ? row.assessment
    : undefined
}

/** The leading mark: working (pulsing), an unseen answer (solid), or an empty slot that keeps titles aligned. */
function Mark({
  working,
  unseen,
  assessment,
}: {
  working?: 'self' | 'subagents'
  unseen: boolean
  assessment?: Assessment
}) {
  const assessed = !working && assessment?.value !== 'neutral' ? assessment?.value : undefined
  const label = working
    ? working === 'self'
      ? 'Working'
      : 'Subagents working'
    : assessed === 'done'
      ? "Done (summary model's opinion, not verified)"
      : assessed === 'needs_input'
        ? "May need input (summary model's opinion, not verified)"
        : 'New answer'
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      {(working || unseen || assessed) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={label}
              role="img"
              className={cn(
                'flex items-center justify-center',
                assessed === 'done' ? 'text-success' : 'text-muted-foreground',
              )}
            >
              {assessed === 'done' ? (
                <CircleCheckIcon className="size-3.5" />
              ) : assessed === 'needs_input' ? (
                <CircleHelpIcon className="size-3.5" />
              ) : (
                <span
                  className={cn('size-1.5 rounded-full bg-brand', working && 'animate-pulse-dot')}
                />
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

/** One top-level conversation: click shows it; the menu renames, clears, concludes or resumes it. */
export function Row({
  conversation,
  shown,
  draft,
  working,
  unseen,
  concluded,
  now,
  onConclude,
  feature,
  assessment,
  activity,
}: {
  conversation: ConversationSummary
  shown: boolean
  draft: boolean
  working?: 'self' | 'subagents'
  unseen: boolean
  concluded: boolean
  now: number
  onConclude: (conclude: boolean) => void
  assessment?: Assessment
  activity?: string
  feature?: string
}) {
  const phase = usePhase(conversation.id)
  const displayPhase = working ? phase : undefined
  const hasActivity = !!(displayPhase || activity)
  // One indicator per row: the phase line's pulsing dot, else the leading mark's while no phase is known yet.
  const markWorking = displayPhase ? undefined : working
  const actions = useUltimate()
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  /** Whether the row button takes focus back once the field closes: after Enter or Escape, not a click elsewhere. */
  const refocus = useRef(false)
  /** What a menu item does once the menu has closed, so focus lands where it should. */
  const afterMenu = useRef<() => void>(undefined)
  const name =
    conversation.title ??
    (draft
      ? 'Untitled conversation'
      : conversation.workspace
        ? 'Untitled conversation'
        : `#${conversation.id}`)
  const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
  const hasMetadata = feature || conversation.workspace || latest > 0
  const rename = () => {
    cancelled.current = false
    setEditing(true)
  }
  const save = (value: string) => {
    setEditing(false)
    if (cancelled.current) return
    const title = value.trim()
    void api.action('conversations', 'rename', { id: conversation.id, title })
  }
  const title = (
    <span
      className={cn(
        'min-w-0 flex-1 truncate text-[13px]',
        conversation.title || !draft
          ? shown
            ? 'text-foreground'
            : 'text-foreground/85'
          : 'text-muted-foreground',
      )}
      onDoubleClick={draft ? undefined : rename}
      title={name}
    >
      {name}
    </span>
  )
  return (
    <div
      className={cn(
        'group relative mx-2 flex items-center rounded-md transition-colors',
        hasActivity ? 'h-[58px]' : hasMetadata ? 'h-11' : 'h-7',
        shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={conversation.id}
    >
      {editing ? (
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-1.5">
          <Mark assessment={assessment} unseen={unseen} working={markWorking} />
          <input
            aria-label="Conversation title"
            autoFocus
            className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            defaultValue={conversation.title ?? ''}
            onBlur={(event) => save(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                // Without it, the keypress lands on the refocused row button and opens the row.
                event.preventDefault()
                refocus.current = true
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                cancelled.current = true
                refocus.current = true
                event.currentTarget.blur()
              }
            }}
          />
        </div>
      ) : (
        <button
          aria-current={shown ? 'true' : undefined}
          className="flex h-full min-w-0 flex-1 cursor-pointer flex-col justify-center rounded-md pr-2 pl-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => actions.switchConversation(conversation.id)}
          ref={(element) => {
            if (!element || !refocus.current) return
            refocus.current = false
            element.focus()
          }}
          type="button"
        >
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <Mark assessment={assessment} unseen={unseen} working={markWorking} />
            {title}
          </span>
          {hasMetadata && (
            <span className="flex w-full items-center gap-2 pr-5 pl-[18px] font-mono text-[10px] leading-4 text-muted-foreground">
              {feature && <FeatureTag feature={feature} />}
              {conversation.workspace && (
                <span className="shrink-0" title="Isolated checkout">
                  #{conversation.id}
                </span>
              )}
              {latest > 0 && (
                <span
                  className="shrink-0 text-muted-foreground/80"
                  title={new Date(latest).toLocaleString()}
                >
                  {ago(latest, now)}
                </span>
              )}
            </span>
          )}
          {hasActivity && (
            <span className="flex w-full min-w-0 items-center gap-1 pr-5 pl-[18px] text-[11px] leading-4 text-muted-foreground/70">
              {displayPhase && (
                <span className="shrink-0 text-brand">
                  <PhaseLabel phase={displayPhase} />
                </span>
              )}
              {displayPhase && activity && <span>·</span>}
              {activity && <span className="truncate">{activity}</span>}
            </span>
          )}
        </button>
      )}
      {(!draft || conversation.workspace) && !editing && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Conversation actions"
            className="invisible absolute right-1 bottom-1 flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible pointer-coarse:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
          >
            <EllipsisIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-44 [&_[role=menuitem]]:cursor-pointer"
            onCloseAutoFocus={(event) => {
              const next = afterMenu.current
              afterMenu.current = undefined
              if (!next) return
              event.preventDefault()
              next()
            }}
          >
            {conversation.workspace && (
              <DropdownMenuItem
                className="cursor-pointer text-[12.5px]"
                onSelect={() =>
                  (afterMenu.current = () => {
                    actions.switchConversation(conversation.id)
                    actions.openPanel('workspaces')
                  })
                }
              >
                <GitBranchIcon />
                Workspace details
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="text-[12.5px]"
              onSelect={() => (afterMenu.current = rename)}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <CompactItem conversation={conversation} />
            <DropdownMenuItem className="text-[12.5px]" onSelect={() => onConclude(!concluded)}>
              <CircleCheckIcon />
              {concluded ? 'Resume' : 'Conclude'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

/**
 * A standing agent or the lander: its fixed `@name`, a leading status mark and one quiet line of state, never a
 * summary, feature or assessment. Click opens it; the menu only compacts its context: it is never cleared, renamed or
 * concluded.
 */
export function StandingRow({
  conversation,
  name,
  shown,
  presence,
  onOpen,
  children,
}: {
  /** Missing until @ultimate's conversation is first opened. */
  conversation?: ConversationSummary
  /** The agent's name without `@`: `ultimate`, `lander`, `cloudflare`, … */
  name: string
  shown: boolean
  presence: Presence
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'group relative mx-2 flex h-11 items-center rounded-md transition-colors',
        shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={conversation?.id}
      data-standing={name}
    >
      <button
        aria-current={shown ? 'true' : undefined}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md pr-2 pl-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onOpen}
        type="button"
      >
        <AgentMark name={name} presence={presence} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {name === 'ultimate' ? (
              // The title bar's wordmark: Ultimate's own name is the brand.
              <span className="truncate font-sans text-[11.5px] leading-5 font-semibold tracking-[0.28em] text-brand">
                ULTIMATE
              </span>
            ) : (
              <span className="truncate text-[13px] leading-5 font-semibold text-foreground">
                {agentTitle(name)}
              </span>
            )}
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">@{name}</span>
          </span>
          <span className="flex w-full min-w-0 items-center gap-2 pr-5 font-mono text-[10px] leading-4 text-muted-foreground">
            {children}
          </span>
        </span>
      </button>
      {conversation && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Conversation actions"
            className="invisible absolute right-1 bottom-1 flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible pointer-coarse:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
          >
            <EllipsisIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44 [&_[role=menuitem]]:cursor-pointer">
            <CompactItem conversation={conversation} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

/** Compacts a conversation's context: the gist stays, older turns leave it; the history stays stored. */
function CompactItem({ conversation }: { conversation: ConversationSummary }) {
  return (
    <DropdownMenuItem
      className="text-[12.5px]"
      disabled={conversation.busy}
      onSelect={() => void api.compact(undefined, conversation.id)}
    >
      <FoldVerticalIcon />
      Compact context
    </DropdownMenuItem>
  )
}

const eventIcons = {
  landed: GitMergeIcon,
  note: StickyNoteIcon,
  branched: GitForkIcon,
  compacted: FoldVerticalIcon,
  started: ScrollTextIcon,
}

/** One line per root event: what happened, in a few words. */
function eventText(event: RootEvent) {
  switch (event.type) {
    case 'landed':
      return (
        <>
          <span className="shrink-0 text-foreground/80">{event.sha}</span>
          <span className="truncate">{event.subject ?? 'landed'}</span>
        </>
      )
    case 'note':
      return (
        <span className="truncate">
          {event.from !== undefined && `#${event.from}: `}
          {event.text.replace(/\s+/g, ' ')}
        </span>
      )
    case 'branched':
      return (
        <>
          <span className="shrink-0 text-foreground/80">#{event.branch}</span>
          <span className="truncate">{event.intent.replace(/\s+/g, ' ')}</span>
        </>
      )
    case 'compacted':
      return <span className="truncate">context compacted</span>
    default:
      return <span className="truncate">context started</span>
  }
}

/** Opens `conversation` at `entry` on the Agent surface. */
function openEntry(
  actions: Pick<ReturnType<typeof useUltimate>, 'switchConversation' | 'showSurface'>,
  conversation: number,
  entry: number,
) {
  events.emit('board:open', { conversation, entry })
  actions.showSurface('agent')
  actions.switchConversation(conversation)
}

/**
 * The head of a tree: its title, the size of the context every branch starts from, and the last three things that
 * happened in it (landings, notes, new branches, compactions), each opening the root at its entry. No feature, summary
 * or assessment; the menu compacts the context or opens @ultimate, who keeps it. A root is never concluded or cleared.
 */
export function RootRow({
  conversation,
  shown,
  working,
  now,
  onTalk,
}: {
  conversation: ConversationSummary
  shown: boolean
  working?: 'self' | 'subagents'
  now: number
  onTalk: () => void
}) {
  const actions = useUltimate()
  const id = conversation.id
  const tally = useDocOf<{ tokens: number; since?: number }>(id, 'lineage.tally')
  const recent = useAction<RootEvent[]>('lineage', 'recent', { id }, { onError: () => {} })
  const { refetch } = recent
  // Every entry the root gets recounts its tokens: a new count means something may have happened.
  const tokens = tally?.tokens
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    void refetch()
  }, [tokens, refetch])
  // A hardcoded name: the root's summary title described its pre-context history, not what it holds now.
  const name = 'Project context'
  return (
    <div
      className={cn(
        'group relative mx-2 rounded-md transition-colors',
        shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={id}
      data-root-row={id}
    >
      <button
        aria-current={shown ? 'true' : undefined}
        className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md pr-7 pl-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => actions.switchConversation(id)}
        title={conversation.title ? `${conversation.title} · #${id}` : `#${id}`}
        type="button"
      >
        <AgentMark name="root" presence={working ? 'working' : undefined} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span
            className={cn(
              'truncate text-[13px] font-semibold',
              shown ? 'text-foreground' : 'text-foreground/90',
            )}
          >
            {name}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">#{id}</span>
        </span>
        {tokens !== undefined && tally?.since !== undefined && (
          <span
            className="shrink-0 font-mono text-[10px] text-muted-foreground/80"
            title="Context every new branch starts from"
          >
            {formatTokens(tokens)}
          </span>
        )}
      </button>
      {!!recent.data?.length && (
        <ul aria-label={`Recent in ${name}`} className="flex flex-col pb-1">
          {recent.data.map((event) => {
            const Icon = eventIcons[event.type]
            return (
              <li key={event.entry}>
                <button
                  className="flex h-5 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm pr-2 pl-[42px] text-left font-mono text-[10.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                  data-root-event={event.type}
                  onClick={() => openEntry(actions, id, event.entry)}
                  title={`Open #${id}/${event.entry}`}
                  type="button"
                >
                  <Icon
                    className={cn(
                      'size-3 shrink-0',
                      event.type === 'landed' ? 'text-success' : 'text-muted-foreground/70',
                    )}
                  />
                  {eventText(event)}
                  {event.at !== undefined && (
                    <span className="ml-auto shrink-0 pl-1 text-muted-foreground/60">
                      {ago(event.at, now)}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label="Root actions"
          className="invisible absolute top-1 right-1 flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible pointer-coarse:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
        >
          <EllipsisIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48 [&_[role=menuitem]]:cursor-pointer">
          <DropdownMenuItem
            className="text-[12.5px]"
            disabled={tally?.since === undefined || working !== undefined}
            onSelect={() => void api.action('lineage', 'compact', { id })}
          >
            <FoldVerticalIcon />
            Compact context
          </DropdownMenuItem>
          <DropdownMenuItem className="text-[12.5px]" onSelect={onTalk}>
            <MessageCircleIcon />
            Talk to @ultimate
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function ChildRow({
  conversation,
  row,
  shown,
}: {
  conversation: ConversationSummary
  row?: OverviewRow
  shown: boolean
}) {
  const actions = useUltimate()
  const task = useTaskOf(conversation.id)
  const working = conversation.busy || row?.runState === 'working'
  const state = working
    ? 'Working'
    : row?.runState === 'answered'
      ? 'Replied'
      : row?.runState === 'error'
        ? 'Run failed'
        : row?.runState === 'queued'
          ? 'Queued'
          : 'Idle'
  return (
    <button
      aria-current={shown ? 'true' : undefined}
      className={cn(
        'mx-1 flex w-[calc(100%-0.5rem)] cursor-pointer flex-col gap-1 rounded-md px-2 py-1.5 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
        shown && 'bg-sidebar-accent',
      )}
      data-child-conversation={conversation.id}
      onClick={() => actions.switchConversation(conversation.id)}
      title={conversation.title}
      type="button"
    >
      <span className="flex w-full items-center gap-1.5">
        <Mark
          assessment={currentAssessment(row)}
          unseen={false}
          working={working ? 'self' : undefined}
        />
        {task && <TaskChip task={task} />}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
          {conversation.label ?? 'Agent'} · #{conversation.id}
        </span>
        {conversation.workspace && (
          <GitBranchIcon
            aria-label="Isolated checkout"
            className="size-3 shrink-0 text-muted-foreground"
          />
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground">{state}</span>
      </span>
      <span className="line-clamp-2 pl-[18px] text-[11px] leading-relaxed break-words text-muted-foreground">
        {task
          ? task.title
          : row?.activity
            ? `${working ? 'Last reply: ' : ''}${row.activity}`
            : (conversation.title ?? 'No reply yet')}
      </span>
      {row?.assessmentStatus === 'error' && !working && (
        <span className="pl-[18px] text-[10px] text-muted-foreground/70">
          Assessment unavailable
        </span>
      )}
    </button>
  )
}
