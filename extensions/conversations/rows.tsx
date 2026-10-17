import {
  GitBranchIcon,
  GitMergeIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  EllipsisIcon,
  EraserIcon,
  PencilIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, cn, useUltimate } from '@/sdk'
import { FeatureTag } from './feature.tsx'
import { TaskChip, useTaskOf } from '../plan/chip.tsx'
import { PhaseLabel, usePhase } from '../phase/chip.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/data.tsx'
import { useWorkspaceIndex } from '../workspaces/data.tsx'
import type { Assessment, OverviewRow } from './types.ts'
import { ago, LanderState } from './lander.tsx'
import { openReset } from './dialogs.tsx'

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
  root,
}: {
  root?: boolean
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
  const lander = conversation.label === 'lander'
  const standing =
    conversation.label === 'agent' &&
    conversation.parentConversationId === undefined &&
    conversation.ownerTaskId === undefined
  const hasMetadata = root || feature || conversation.workspace || latest > 0 || lander
  const index = useWorkspaceIndex()
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
        (lander || standing) && 'font-semibold text-foreground',
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
          <Mark assessment={assessment} unseen={unseen} working={working} />
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
            {lander ? (
              <GitMergeIcon
                aria-label="Lander"
                className="size-3 shrink-0 text-brand"
                strokeWidth={2.5}
              />
            ) : (
              <Mark assessment={assessment} unseen={unseen} working={working} />
            )}
            {title}
          </span>
          {hasMetadata && (
            <span className="flex w-full items-center gap-2 pr-5 pl-[18px] font-mono text-[10px] leading-4 text-muted-foreground">
              {root && (
                <span className="flex shrink-0 items-center gap-1">
                  <GitBranchIcon aria-label="Root" className="size-2.5" />
                  root
                </span>
              )}
              {feature && !lander && <FeatureTag feature={feature} />}
              {lander ? (
                <LanderState id={conversation.id} index={index} now={now} working={!!working} />
              ) : (
                conversation.workspace && (
                  <span className="shrink-0" title="Isolated checkout">
                    #{conversation.id}
                  </span>
                )
              )}
              {latest > 0 && !lander && (
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
            <DropdownMenuItem
              className="text-[12.5px]"
              disabled={conversation.busy}
              onSelect={() => (afterMenu.current = () => openReset(actions, conversation.id))}
            >
              <EraserIcon />
              Clear context…
            </DropdownMenuItem>
            {!lander && !standing && (
              <DropdownMenuItem className="text-[12.5px]" onSelect={() => onConclude(!concluded)}>
                <CircleCheckIcon />
                {concluded ? 'Resume' : 'Conclude'}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
