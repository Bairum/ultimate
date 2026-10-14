import { ChevronRightIcon, ChevronDownIcon, SquarePenIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
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
  formatKeys,
  useAction,
  useEvent,
  useExtensionUiState,
  useNow,
  useStore,
  useTasks,
  useUltimate,
} from '@/sdk'
import { hiddenConversationIds } from './visible.tsx'
import { useOverview } from './feature.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/data.tsx'
import { useWorkspaceConversations as useConversations } from '../workspaces/data.tsx'
import { currentAssessment, Row, ChildRow } from './rows.tsx'
import { newKeys } from './new-dialog.tsx'

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

/** Siblings by latest input, newest first. */
const byInput = (a: ConversationSummary, b: ConversationSummary) =>
  (b.inputAt ?? 0) - (a.inputAt ?? 0) || b.id - a.id

function Shortcut({ keys }: { keys: string }) {
  return (
    <KbdGroup>
      {formatKeys(keys)[0]?.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  )
}

/** The project tree, with owned subagents under each row and earlier/concluded work at the bottom. */
export function Conversations() {
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
  const hiddenIds = hiddenConversationIds(conversations, archived)
  const summary = shownTop && !hiddenIds.has(shownTop.id) ? overview[shownTop.id] : undefined
  const info = useAction<{ root: number }>('lineage', 'info')
  useEvent('lineage:root-changed', () => void info.refetch())
  const rootId = info.data?.root
  const [expanded, setExpanded] = useExtensionUiState<number[]>('expanded', [])
  const working = workingByTop(conversations)
  const topLevel = conversations.filter(
    (conversation) => conversation.parentConversationId === undefined,
  )
  // Lander conversations are always there, pinned above the rest and never archived.
  const landers = topLevel
    .filter((conversation) => conversation.label === 'lander')
    .toSorted((a, b) => a.id - b.id)
  const listed = topLevel
    .filter((conversation) => conversation.label !== 'lander' && !hiddenIds.has(conversation.id))
    .toSorted(byInput)
  const hidden = topLevel
    .filter((conversation) => conversation.label !== 'lander' && hiddenIds.has(conversation.id))
    .toSorted(byInput)
  const root = listed.find((conversation) => conversation.id === rootId)
  const earlier = listed.filter(
    (conversation) => conversation.id !== rootId && !conversation.branchOf,
  )
  const branchesBySource = new Map<number, ConversationSummary[]>()
  for (const conversation of topLevel.toSorted(byInput)) {
    if (conversation.id === rootId || !conversation.branchOf) continue
    const source = conversation.branchOf.conversationId
    branchesBySource.set(source, [...(branchesBySource.get(source) ?? []), conversation])
  }

  const setArchive = (id: number, archive: boolean) => {
    const resumed = new Set([id])
    if (!archive) {
      let current = conversations.find((conversation) => conversation.id === id)
      while (current?.branchOf && !resumed.has(current.branchOf.conversationId)) {
        resumed.add(current.branchOf.conversationId)
        current = conversations.find(
          (conversation) => conversation.id === current?.branchOf?.conversationId,
        )
      }
    }
    setArchived((previous) => [
      ...previous.filter((candidate) => !resumed.has(candidate)),
      ...(archive ? [id] : []),
    ])
    if (!archive || !hiddenConversationIds(conversations, [id]).has(shownTop?.id ?? -1)) return
    const index = listed.findIndex((conversation) => conversation.id === id)
    const subtree = hiddenConversationIds(conversations, [id])
    const next =
      listed.slice(index + 1).find((candidate) => !subtree.has(candidate.id)) ??
      listed.find((candidate) => !subtree.has(candidate.id))
    if (next) actions.switchConversation(next.id)
  }
  const row = (conversation: ConversationSummary) => {
    const recorded = seen[conversation.id]
    const state = working.get(conversation.id)
    return (
      <Row
        assessment={tasks ? currentAssessment(overview[conversation.id]) : undefined}
        archived={hiddenIds.has(conversation.id)}
        root={conversation.id === rootId}
        conversation={conversation}
        draft={conversation.inputAt === undefined}
        feature={overview[conversation.id]?.feature}
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
  const tree = (conversation: ConversationSummary, nested = false, concluded = false) => {
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
              {children.map((child) => tree(child, true, concluded))}
            </CollapsibleContent>
          </Collapsible>
        )}
        {!nested &&
          (branchesBySource.get(conversation.id) ?? []).some(
            (branch) => hiddenIds.has(branch.id) === concluded,
          ) && (
            <div className="ml-4 border-l border-border/60" data-branches-of={conversation.id}>
              {(branchesBySource.get(conversation.id) ?? [])
                .filter((branch) => hiddenIds.has(branch.id) === concluded)
                .map((branch) => tree(branch, false, concluded))}
            </div>
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
        {landers.length > 0 && (
          <div className="mb-1 flex flex-col gap-px border-b border-border/60 pb-1">
            {landers.map((conversation) => tree(conversation))}
          </div>
        )}
        {root && tree(root)}
        {listed
          .filter(
            (conversation) =>
              conversation.branchOf &&
              conversation.id !== rootId &&
              !listed.some((source) => source.id === conversation.branchOf?.conversationId),
          )
          .map((conversation) => tree(conversation))}
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
      <div className="mt-auto pt-3">
        {earlier.length > 0 && (
          <Collapsible className="pt-1">
            <CollapsibleTrigger className="group/earlier flex w-full cursor-pointer items-center gap-1 px-4 py-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/earlier:rotate-90" />
              Earlier · {earlier.length}
            </CollapsibleTrigger>
            <CollapsibleContent
              aria-label="Earlier"
              role="region"
              className="flex flex-col gap-px pt-1"
            >
              {earlier.map((conversation) => tree(conversation))}
            </CollapsibleContent>
          </Collapsible>
        )}
        {hidden.length > 0 && (
          <Collapsible className="pt-1">
            <CollapsibleTrigger className="group/archived flex w-full cursor-pointer items-center gap-1 px-4 py-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/archived:rotate-90" />
              Concluded · {hidden.length}
            </CollapsibleTrigger>
            <CollapsibleContent
              aria-label="Concluded"
              className="flex flex-col gap-px pt-1"
              role="region"
            >
              {hidden
                .filter(
                  (conversation) =>
                    conversation.id === rootId ||
                    !hidden.some((source) => source.id === conversation.branchOf?.conversationId),
                )
                .map((conversation) => tree(conversation, false, true))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  )
}

/** Records the answer the user has seen: the shown top-level conversation's latest, once it is idle. */
export function Seen() {
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
