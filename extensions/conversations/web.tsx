import { applyImmutable } from '@earendil-works/chord/delta'
import type { Op } from '@earendil-works/chord/delta'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  GitBranchIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  EllipsisIcon,
  EraserIcon,
  PencilIcon,
  SquarePenIcon,
} from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  formatKeys,
  getConversation,
  getState,
  useDialog,
  useExtensionUiState,
  useModels,
  useNow,
  useStore,
  useTasks,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, UltimateActions } from '@/sdk'
import { ModelRow } from '../models/picker.tsx'
import { parseSummaryModel } from './summary-model-ref.ts'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/data.tsx'
import {
  getWorkspaces,
  useWorkspaceConversations as useConversations,
} from '../workspaces/data.tsx'
import type {
  Assessed,
  Assessment,
  IntentSummary,
  SpawnSummary,
  OverviewRow,
  OverviewState,
  SummaryDiscard,
  TitleChange,
} from './types.ts'

const newKeys = 'mod+alt+n'
const resetDialog = 'conversations.reset'
const summaryModelDialog = 'conversations.summary-model'
let creationType = 'isolated'
let creating = false
const overviewKind = 'ultimate.conversation-overview'

/** One root stream for all rows, unchanged when selection or expansion changes. */
function useOverview() {
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

function currentAssessment(row: OverviewRow | undefined) {
  return row?.runState === 'answered' &&
    row.assessment?.answerId === row.answerId &&
    row.assessment?.inputId === row.inputId
    ? row.assessment
    : undefined
}

/** The shown conversation, also while its snapshot is still on the way. */
const useShownId = () => useStore((state) => state.view?.conversation.id ?? state.requested)

/** The top-level conversation above `id` by parent links, or `id`'s own summary when it is top-level. */
function topOf(id: number | undefined, conversations: readonly ConversationSummary[]) {
  let current = conversations.find((conversation) => conversation.id === id)
  while (current?.parentConversationId !== undefined) {
    const parent = current.parentConversationId
    current = conversations.find((conversation) => conversation.id === parent)
  }
  return current
}

/** Why a top-level conversation is working: its own run, or only runs of conversations below it. */
function workingByTop(conversations: readonly ConversationSummary[]) {
  const working = new Map<number, 'self' | 'subagents'>()
  for (const conversation of conversations) {
    if (
      !conversation.busy ||
      (conversation.parentConversationId !== undefined && conversation.ownerTaskId === undefined)
    )
      continue
    const top = topOf(conversation.id, conversations)
    if (!top) continue
    working.set(top.id, top.id === conversation.id ? 'self' : (working.get(top.id) ?? 'subagents'))
  }
  return working
}

/** The empty draft first, then by latest input, newest first. */
const byInput = (a: ConversationSummary, b: ConversationSummary) =>
  (b.inputAt ?? Infinity) - (a.inputAt ?? Infinity) || b.id - a.id

/** `now`, `5m`, `3h`, `2d`, then a short date. */
function ago(at: number, now: number) {
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

/** Focus the composer once conversation `id` has rendered and no dialog (the palette) holds focus any longer. */
function focusWhenShown(actions: UltimateActions, id: number, deadline = Date.now() + 5000) {
  requestAnimationFrame(() => {
    if (getConversation().id === id && !document.querySelector('[role="dialog"]'))
      actions.focusComposer()
    else if (Date.now() < deadline) focusWhenShown(actions, id, deadline)
  })
}

/**
 * Show an empty conversation on the Agent surface, the composer focused: the shown draft, else an empty, untitled,
 * idle one nobody archived, else a new one. It takes the shown conversation's model and thinking level, not a
 * subagent's.
 */
async function newConversation(actions: UltimateActions) {
  const { conversations, shared, models } = getState()
  const shown = getConversation()
  actions.showSurface('agent')
  const current = conversations.find((conversation) => conversation.id === shown.id)
  const topLevel = current !== undefined && current.parentConversationId === undefined
  // The replica, not the lagging summary: right after a first send, the shown conversation is no draft any longer.
  if (topLevel && !getWorkspaces()[String(current.id)] && shown.entries.length === 0) {
    focusWhenShown(actions, current.id)
    return
  }
  const archived = shared?.['ext.conversations.archived']
  const reusable = conversations
    .filter(
      (conversation) =>
        conversation.parentConversationId === undefined &&
        conversation.inputAt === undefined &&
        conversation.title === undefined &&
        !getWorkspaces()[String(conversation.id)] &&
        !conversation.busy &&
        !(Array.isArray(archived) && archived.includes(conversation.id)),
    )
    .toSorted((a, b) => b.id - a.id)[0]
  const id = reusable?.id ?? (await api.createConversation()).id
  const { model, thinkingLevel } = shown.agent
  // A level the model does not support fails the whole call; without one, the server clamps the current level.
  const levels = models?.models.find(
    (candidate) => candidate.provider === model?.provider && candidate.id === model.modelId,
  )?.thinkingLevels
  if (topLevel && model)
    await api
      .configure(
        { model, ...(thinkingLevel && levels?.includes(thinkingLevel) && { thinkingLevel }) },
        id,
      )
      .catch(() => undefined)
  actions.switchConversation(id)
  focusWhenShown(actions, id)
}

/** Both creation commands share a guard; failures propagate to the command notice handler. */
async function createConversation(actions: UltimateActions, type = creationType) {
  if (creating) return
  creating = true
  try {
    if (type === 'shared') await newConversation(actions)
    else {
      const { id } = await api.action<{ id: number }>('workspaces', 'create', {})
      actions.showSurface('agent')
      actions.switchConversation(id)
      focusWhenShown(actions, id)
    }
  } finally {
    creating = false
  }
}

/** The conversation the clear-context dialog asks about; set just before it opens. */
let resetTarget: number | undefined
function openReset(actions: Pick<UltimateActions, 'open'>, id: number) {
  resetTarget = id
  actions.open(resetDialog)
}

function Shortcut({ keys }: { keys: string }) {
  return (
    <KbdGroup>
      {formatKeys(keys)[0]?.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  )
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

/** One top-level conversation: click shows it; the menu renames, clears, archives or unarchives it. */
function Row({
  conversation,
  shown,
  draft,
  working,
  unseen,
  archived,
  now,
  onArchive,
  assessment,
}: {
  conversation: ConversationSummary
  shown: boolean
  draft: boolean
  working?: 'self' | 'subagents'
  unseen: boolean
  archived: boolean
  now: number
  onArchive: (archive: boolean) => void
  assessment?: Assessment
}) {
  const actions = useUltimate()
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  /** Whether the row button takes focus back once the field closes: after Enter or Escape, not a click elsewhere. */
  const refocus = useRef(false)
  /** What a menu item does once the menu has closed, so focus lands where it should. */
  const afterMenu = useRef<() => void>(undefined)
  const name = conversation.title ?? (draft ? 'New conversation' : `#${conversation.id}`)
  const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
  const hasMetadata = conversation.workspace || latest > 0
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
        hasMetadata ? 'h-11' : 'h-7',
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
            <Mark assessment={assessment} unseen={unseen} working={working} />
            {title}
          </span>
          {hasMetadata && (
            <span className="flex w-full items-center gap-2 pr-5 pl-[18px] font-mono text-[10px] leading-4 text-muted-foreground">
              {conversation.workspace && <span title="Isolated checkout">W{conversation.id}</span>}
              {latest > 0 && (
                <span
                  className="text-muted-foreground/80"
                  title={new Date(latest).toLocaleString()}
                >
                  {ago(latest, now)}
                </span>
              )}
            </span>
          )}
        </button>
      )}
      {(!draft || conversation.workspace) && !editing && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Conversation actions"
            className="invisible absolute right-1 bottom-1 flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
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
            <DropdownMenuItem className="text-[12.5px]" onSelect={() => onArchive(!archived)}>
              {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {archived ? 'Unarchive' : 'Archive'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

function ChildRow({
  conversation,
  row,
  shown,
}: {
  conversation: ConversationSummary
  row?: OverviewRow
  shown: boolean
}) {
  const actions = useUltimate()
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
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
          {conversation.label ?? 'Agent'} · #{conversation.id}
        </span>
        {conversation.workspace && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            W{conversation.id}
          </span>
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground">{state}</span>
      </span>
      <span className="line-clamp-2 pl-[18px] text-[11px] leading-relaxed break-words text-muted-foreground">
        {row?.activity
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

/**
 * The project's top-level conversations that have a message, newest input first, under the shown one when it is an
 * empty draft; archived ones in a collapsed group at the bottom.
 */
function Conversations() {
  const overview = useOverview()
  const tasks = useTasks()
  const foreground = new Set<number>(
    Object.values(tasks?.tasks ?? {})
      .filter((task) => !task.background)
      .map((task) => task.conversationId),
  )
  // The task graph reflects the run; the timestamp/title list can lag.
  const conversations = useConversations().map((conversation) => ({
    ...conversation,
    busy: foreground.has(conversation.id) || overview[conversation.id]?.runState === 'working',
  }))
  const actions = useUltimate()
  const shownId = useShownId()
  const now = useNow(60_000)
  const [type, setType] = useExtensionUiState('creationType', 'isolated')
  const [archived, setArchived] = useExtensionUiState<number[]>('archived', [])
  const [seen] = useExtensionUiState<Record<string, number>>('seen', {})
  const shownTop = topOf(shownId, conversations)
  const summary = shownTop && !archived.includes(shownTop.id) ? overview[shownTop.id] : undefined
  const [expanded, setExpanded] = useExtensionUiState<number[]>('expanded', [])
  const working = workingByTop(conversations)
  const topLevel = conversations.filter(
    (conversation) => conversation.parentConversationId === undefined,
  )
  const listed = topLevel
    .filter(
      (conversation) =>
        !archived.includes(conversation.id) &&
        (conversation.inputAt !== undefined ||
          conversation.id === shownTop?.id ||
          conversation.workspace !== undefined),
    )
    .toSorted(byInput)
  const hidden = topLevel
    .filter((conversation) => archived.includes(conversation.id))
    .toSorted(byInput)

  const setArchive = (id: number, archive: boolean) => {
    setArchived((previous) => [
      ...previous.filter((candidate) => candidate !== id),
      ...(archive ? [id] : []),
    ])
    if (!archive || id !== shownTop?.id) return
    const index = listed.findIndex((conversation) => conversation.id === id)
    const next = listed[index + 1] ?? listed[index - 1]
    if (next) actions.switchConversation(next.id)
  }
  const row = (conversation: ConversationSummary) => {
    const recorded = seen[conversation.id]
    const state = working.get(conversation.id)
    return (
      <Row
        assessment={tasks ? currentAssessment(overview[conversation.id]) : undefined}
        archived={archived.includes(conversation.id)}
        conversation={conversation}
        draft={conversation.inputAt === undefined}
        key={conversation.id}
        now={now}
        onArchive={(archive) => setArchive(conversation.id, archive)}
        shown={conversation.id === shownTop?.id}
        unseen={
          recorded !== undefined &&
          (conversation.answerAt ?? 0) > recorded &&
          conversation.id !== shownId &&
          state === undefined
        }
        working={state}
      />
    )
  }

  const childrenByParent = new Map<number, ConversationSummary[]>()
  for (const candidate of conversations) {
    const parent = candidate.parentConversationId
    if (candidate.ownerTaskId === undefined || parent === undefined) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(candidate)
    childrenByParent.set(parent, children)
  }
  const tree = (conversation: ConversationSummary, nested = false) => {
    const children = childrenByParent.get(conversation.id) ?? []
    const open = expanded.includes(conversation.id)
    return (
      <div key={conversation.id}>
        {nested ? (
          <ChildRow
            conversation={conversation}
            row={overview[conversation.id]}
            shown={shownId === conversation.id}
          />
        ) : (
          row(conversation)
        )}
        {children.length > 0 && (
          <Collapsible
            open={open}
            onOpenChange={(next) =>
              setExpanded((previous) => [
                ...previous.filter((id) => id !== conversation.id),
                ...(next ? [conversation.id] : []),
              ])
            }
          >
            <CollapsibleTrigger
              aria-label={`Sub-agents of conversation ${conversation.id}`}
              className="group/agents ml-5 flex cursor-pointer items-center gap-1 py-1 text-[10.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/agents:rotate-90" />
              Sub-agents · {children.length}
            </CollapsibleTrigger>
            <CollapsibleContent className="ml-4 border-l border-border/60">
              {children.map((child) => tree(child, true))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col pb-2">
      <div className="mb-1 flex h-10 shrink-0 items-center gap-2 border-b border-border/70 pr-1.5 pl-4 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Conversations
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="New conversation"
              className="ml-auto size-7 cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={() => actions.runCommand('conversations.new')}
              size="icon"
              variant="ghost"
            >
              <SquarePenIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2">
            New {type === 'shared' ? 'shared' : 'isolated'} conversation
            <Shortcut keys={newKeys} />
          </TooltipContent>
        </Tooltip>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Conversation creation options"
            className="flex size-6 cursor-pointer items-center justify-center rounded-sm outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronDownIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={type}
              onValueChange={(value) => {
                creationType = value
                setType(value)
              }}
            >
              <DropdownMenuRadioItem className="cursor-pointer text-xs" value="isolated">
                Isolated
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem className="cursor-pointer text-xs" value="shared">
                Shared (not isolated)
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <div role="separator" className="my-1 border-t border-border" />
            <DropdownMenuItem
              className="cursor-pointer text-xs"
              onSelect={() => actions.openPanel('workspaces')}
            >
              Manage workspaces
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <nav aria-label="Conversations" className="flex flex-col gap-px">
        {listed.map((conversation) => tree(conversation))}
      </nav>
      {summary &&
        (summary.summary ||
          [summary.summaryStatus, summary.assessmentStatus].some(
            (status) => status === 'pending' || status === 'error',
          )) && (
          <section
            aria-label="Conversation summary"
            className="mx-4 mt-4 border-t border-border/60 pt-3"
            data-summary-conversation={shownTop?.id}
          >
            <p className="text-xs leading-relaxed break-words text-muted-foreground">
              {summary.summary}
            </p>
            {(summary.summaryStatus === 'pending' || summary.assessmentStatus === 'pending') && (
              <p className="mt-1 text-[10.5px] text-muted-foreground/70" role="status">
                {summary.summaryStatus === 'pending' ? 'Updating summary…' : 'Assessing reply…'}
              </p>
            )}
            {(summary.summaryStatus === 'error' || summary.assessmentStatus === 'error') && (
              <p className="mt-1 text-[10.5px] text-muted-foreground/70" role="status">
                {summary.summaryStatus === 'error'
                  ? 'Summary unavailable'
                  : 'Assessment unavailable'}{' '}
                · retries after next reply
              </p>
            )}
          </section>
        )}
      {hidden.length > 0 && (
        <Collapsible className="mt-auto pt-3">
          <CollapsibleTrigger className="group/archived flex w-full items-center gap-1 px-4 py-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground">
            <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/archived:rotate-90" />
            Archived · {hidden.length}
          </CollapsibleTrigger>
          <CollapsibleContent
            aria-label="Archived"
            className="flex flex-col gap-px pt-1"
            role="region"
          >
            {hidden.map((conversation) => tree(conversation))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

/** Records the answer the user has seen: the shown top-level conversation's latest, once it is idle. */
function Seen() {
  // Commands stay in sync even when the sidebar is not mounted.
  const [type] = useExtensionUiState('creationType', 'isolated')
  creationType = type
  const id = useShownId()
  const summary = useConversations().find((conversation) => conversation.id === id)
  const [seen, setSeen] = useExtensionUiState<Record<string, number>>('seen', {})
  const answerAt =
    summary && summary.parentConversationId === undefined && !summary.busy
      ? (summary.answerAt ?? 0)
      : undefined
  useEffect(() => {
    if (id === undefined || answerAt === undefined || seen[id] === answerAt) return
    setSeen((previous) => ({ ...previous, [id]: answerAt }))
  }, [id, answerAt, seen, setSeen])
  return null
}

/** Asks before a context reset, from the row menu or the command; a failure stays in the dialog. */
function ResetDialog() {
  const [open, setOpen] = useDialog(resetDialog)
  const conversation = useConversations().find((candidate) => candidate.id === resetTarget)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const close = () => {
    setOpen(false)
    setError(undefined)
  }
  const confirm = async () => {
    setPending(true)
    setError(undefined)
    try {
      await api.action('conversations', 'reset', { id: resetTarget ?? null })
      close()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog onOpenChange={(next) => (next ? setOpen(true) : close())} open={open}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <div className="px-5 pt-5 pb-4">
          <DialogTitle className="text-[14px] font-medium">Clear the context</DialogTitle>
          <DialogDescription className="mt-2 text-[13px] leading-relaxed break-words">
            Clear the context of{' '}
            <span className="text-foreground">
              {conversation?.title ?? `#${resetTarget ?? '?'}`}
            </span>
            ? The agent starts fresh; the history stays stored.
          </DialogDescription>
          {error && <p className="mt-3 font-mono text-[12px] break-words text-error">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
          <Button onClick={close} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button disabled={pending || conversation?.busy} onClick={() => void confirm()} size="sm">
            {pending ? 'Clearing…' : 'Clear context'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type SummaryModelSetting = {
  value: unknown
  source: 'default' | 'user' | 'project'
  default: string
  /** The project's settings file, when it decides the model. */
  path?: string
}

/**
 * Picks the model for titles, summaries, assessments and conclusions, saved as `summaryModel` in the user's settings.
 * It shows the effective value and where it comes from. A project's setting overrides the user's and is never written
 * here: while it applies, picking is disabled.
 */
function SummaryModelDialog() {
  const [open, setOpen] = useDialog(summaryModelDialog)
  const models = useModels()
  const [setting, setSetting] = useState<SummaryModelSetting>()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!open) return
    setError(undefined)
    setQuery('')
    api
      .action<SummaryModelSetting>('conversations', 'summaryModel')
      .then(setSetting, (failure: unknown) => setError(errorMessage(failure)))
  }, [open])
  const current = typeof setting?.value === 'string' ? setting.value : undefined
  const parsed = current === undefined ? undefined : parseSummaryModel(current)
  const ref = parsed && `${parsed.provider}/${parsed.id}`
  const locked = setting?.source === 'project'
  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const found = (models?.models ?? []).filter(
      (model) =>
        model.available &&
        terms.every((term) =>
          `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(term),
        ),
    )
    return [...Map.groupBy(found.slice(0, 150), (model) => model.provider)]
  }, [models, query])
  const choose = async (value: string | null) => {
    setError(undefined)
    try {
      const next = await api.action<SummaryModelSetting>('conversations', 'setSummaryModel', {
        value,
      })
      setSetting(next)
      setOpen(false)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="top-[16%] translate-y-0 gap-0 overflow-hidden p-0 font-mono sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Summary model</DialogTitle>
        <DialogDescription className="sr-only">
          The model that writes titles, summaries, reply assessments and Canvas conclusions.
        </DialogDescription>
        <div className="flex items-baseline gap-2 border-b border-border/70 px-3 py-2 text-[12px]">
          <span className="text-muted-foreground">Summary model</span>
          <span className="min-w-0 truncate text-foreground" data-testid="summary-model-current">
            {setting ? String(setting.value) : '…'}
          </span>
          {setting && (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {setting.source === 'default'
                ? 'default'
                : setting.source === 'user'
                  ? '~/.ultimate/settings.json'
                  : 'set by project settings'}
            </span>
          )}
        </div>
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:uppercase"
          key={setting?.source}
          defaultValue={setting?.source === 'default' ? 'default' : ref}
          shouldFilter={false}
        >
          <CommandInput
            className="text-[13px]"
            onValueChange={setQuery}
            placeholder="Search logged-in models…"
            value={query}
          />
          <CommandList className="max-h-[50vh]">
            <CommandEmpty className="py-6 text-center text-[12px] text-muted-foreground">
              No logged-in model matches.
            </CommandEmpty>
            {!query && setting && (
              <CommandGroup heading="Default">
                <CommandItem
                  className="gap-2 py-1 font-mono text-[12px]"
                  disabled={locked}
                  onSelect={() => void choose(null)}
                  value="default"
                >
                  <CheckIcon
                    className={cn(
                      'size-3.5',
                      setting.source === 'default' ? 'text-brand' : 'opacity-0',
                    )}
                  />
                  Use the default
                  <span className="truncate text-muted-foreground">{setting.default}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {groups.map(([provider, items]) => (
              <Fragment key={provider}>
                <CommandGroup heading={provider}>
                  {items.map((model) => (
                    <ModelRow
                      current={
                        setting?.source !== 'default' && ref === `${model.provider}/${model.id}`
                      }
                      disabled={locked}
                      key={`${model.provider}/${model.id}`}
                      model={model}
                      onSelect={() => void choose(`${model.provider}/${model.id}`)}
                    />
                  ))}
                </CommandGroup>
              </Fragment>
            ))}
          </CommandList>
          <div className="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
            {error ? (
              <span className="text-error">{error}</span>
            ) : locked ? (
              `Set by project settings: edit ${setting.path} to change it`
            ) : (
              'Titles, summaries, assessments and conclusions · saved in ~/.ultimate/settings.json'
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

const assessmentLabel = { needs_input: 'may need input', done: 'Done', neutral: 'neutral' }

/** What a summary task concluded, as one quiet line; each entry traces to its task by `byTaskId`. */
function summaryText(entry: EntryRecord) {
  switch (entry.kind) {
    case 'conversations.intent-summarized':
      return `Intent: ${(entry.data as IntentSummary).summary}`
    case 'conversations.title-changed':
      return `Title changed to “${(entry.data as TitleChange).title}”`
    case 'conversations.summarized':
      return `Summary: ${(entry.data as SpawnSummary).summary}`
    case 'conversations.assessed': {
      const data = entry.data as Assessed
      return `Assessed: ${assessmentLabel[data.value]} (summary model's opinion) · ${data.activity}`
    }
    default: {
      const data = entry.data as SummaryDiscard
      return data.reason === 'stale'
        ? 'Summary superseded by newer work'
        : `Summary unavailable: ${data.cause}`
    }
  }
}

function SummaryAction({ entry }: { entry: EntryRecord }) {
  const text = summaryText(entry)
  const date = new Date((entry.data as { at: number }).at)
  return (
    <div className="flex items-baseline gap-2 font-mono text-[11px] text-muted-foreground">
      <PencilIcon aria-hidden className="size-3 shrink-0 self-center" />
      <span className="min-w-0 break-words">{text}</span>
      <time
        className="shrink-0 text-muted-foreground/70"
        dateTime={date.toISOString()}
        title={date.toLocaleString()}
      >
        {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
    </div>
  )
}

export default defineWebExtension({
  entries: {
    'conversations.title-changed': SummaryAction,
    'conversations.intent-summarized': SummaryAction,
    'conversations.summarized': SummaryAction,
    'conversations.assessed': SummaryAction,
    'conversations.summary-discarded': SummaryAction,
  },
  slots: { sidebar: Conversations, overlay: [ResetDialog, SummaryModelDialog, Seen] },
  commands: [
    {
      id: 'conversations.new',
      title: 'New conversation',
      keys: newKeys,
      group: 'Conversations',
      run: (context) => createConversation(context),
    },
    {
      id: 'conversations.new-isolated',
      title: 'New isolated conversation',
      group: 'Conversations',
      run: (actions) => createConversation(actions, 'isolated'),
    },
    {
      id: 'conversations.summary-model',
      title: 'Summary model…',
      group: 'Conversations',
      run: (actions) => actions.open(summaryModelDialog),
    },
    {
      id: 'conversations.reset',
      title: 'Clear the context',
      group: 'Conversations',
      when: () => {
        const { id, busy, entries } = getConversation()
        const summary = getState().conversations.find((conversation) => conversation.id === id)
        return (
          id !== undefined &&
          !busy &&
          entries.length > 0 &&
          summary?.parentConversationId === undefined
        )
      },
      run: (context) => {
        const { id } = getConversation()
        if (id !== undefined) openReset(context, id)
      },
    },
  ],
})
