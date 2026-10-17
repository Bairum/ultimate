import { ChevronRightIcon, GitBranchIcon, MessageCircleIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { WorkspacePending } from '../workspaces/types.ts'
import {
  api,
  cn,
  errorMessage,
  useExtensionUiState,
  useNow,
  useStore,
  useSystem,
  useTasks,
  useUltimate,
} from '@/sdk'
import { hiddenConversationIds } from './visible.tsx'
import { useOverview } from './feature.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/data.tsx'
import { useWorkspaceConversations as useConversations } from '../workspaces/data.tsx'
import { currentAssessment, Row, ChildRow } from './rows.tsx'
import { useRoots } from '../lineage/roots.tsx'
import { talkToUltimate } from './ultimate.tsx'

/** The label of side chats with a tally, which old projects still store; they stay unlisted. */
const sideLabel = 'side chat'

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

const pinned = (conversation: ConversationSummary) =>
  conversation.label === 'lander' ||
  (conversation.label === 'agent' &&
    conversation.parentConversationId === undefined &&
    conversation.ownerTaskId === undefined)

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
  const conversations = useConversations()
    .filter((conversation) => conversation.label !== sideLabel)
    .map((conversation) => ({
      ...conversation,
      busy: foreground.has(conversation.id) || overview[conversation.id]?.runState === 'working',
    }))
  const actions = useUltimate()
  const workspacesEnabled = useSystem()?.extensions.some(
    (extension) => extension.name === 'workspaces' && extension.enabled,
  )
  const shownId = useShownId()
  const now = useNow(60_000)
  const [concludedIds] = useExtensionUiState<number[]>('concluded', [])
  const [seen] = useExtensionUiState<Record<string, number>>('seen', {})
  const shownTop = topOf(shownId, conversations)
  const hiddenIds = hiddenConversationIds(conversations, concludedIds)
  const summary = shownTop && !hiddenIds.has(shownTop.id) ? overview[shownTop.id] : undefined
  const roots = new Set(useRoots())
  const [expanded, setExpanded] = useExtensionUiState<number[]>('expanded', [])
  const [collapsedRoots, setCollapsedRoots] = useExtensionUiState<number[]>('collapsedRoots', [])
  const working = workingByTop(conversations)
  const topLevel = conversations.filter(
    (conversation) => conversation.parentConversationId === undefined,
  )
  // Standing agents and landers are pinned above the rest and never concluded.
  const landers = topLevel.filter(pinned).toSorted((a, b) => a.id - b.id)
  const listed = topLevel
    .filter((conversation) => !pinned(conversation) && !hiddenIds.has(conversation.id))
    .toSorted(byInput)
  const hidden = topLevel
    .filter((conversation) => !pinned(conversation) && hiddenIds.has(conversation.id))
    .toSorted(byInput)
  const earlier = listed.filter(
    (conversation) => !roots.has(conversation.id) && !conversation.branchOf,
  )
  const branchesBySource = new Map<number, ConversationSummary[]>()
  for (const conversation of topLevel.toSorted(byInput)) {
    if (roots.has(conversation.id) || !conversation.branchOf) continue
    const source = conversation.branchOf.conversationId
    branchesBySource.set(source, [...(branchesBySource.get(source) ?? []), conversation])
  }
  /** The listed (or concluded) branches below `id`, at any depth. */
  const branchesBelow = (id: number, concluded = false): ConversationSummary[] =>
    (branchesBySource.get(id) ?? [])
      .filter((branch) => hiddenIds.has(branch.id) === concluded)
      .flatMap((branch) => [branch, ...branchesBelow(branch.id, concluded)])
  const latestIn = (root: ConversationSummary) =>
    Math.max(root.inputAt ?? 0, ...branchesBelow(root.id).map((branch) => branch.inputAt ?? 0))
  // Trees by their newest input anywhere in them, newest first.
  const rootRows = listed
    .filter((conversation) => roots.has(conversation.id))
    .toSorted((a, b) => latestIn(b) - latestIn(a) || b.id - a.id)

  const [warning, setWarning] = useState<{
    id: number
    work?: WorkspacePending[]
    failure?: string
  }>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const setConclude = async (id: number, conclude: boolean) => {
    await api.action('conversations', conclude ? 'conclude' : 'resume', { ids: [id] })
    if (!conclude || !hiddenConversationIds(conversations, [id]).has(shownTop?.id ?? -1)) return
    const index = listed.findIndex((conversation) => conversation.id === id)
    const subtree = hiddenConversationIds(conversations, [id])
    const next =
      listed.slice(index + 1).find((candidate) => !subtree.has(candidate.id)) ??
      listed.find((candidate) => !subtree.has(candidate.id))
    if (next) actions.switchConversation(next.id)
  }
  const requestConclude = async (id: number, conclude: boolean) => {
    if (conclude && workspacesEnabled) {
      setError(undefined)
      try {
        const work = await api.action<WorkspacePending[]>('workspaces', 'pending', { ids: [id] })
        if (work.length) {
          setWarning({ id, work })
          return
        }
      } catch (failure) {
        setWarning({ id, failure: errorMessage(failure) })
        // Unhandled ActionErrors become notices; the dialog still lets the user conclude.
        throw failure
      }
    }
    await setConclude(id, conclude)
  }
  const row = (conversation: ConversationSummary, shown = conversation.id === shownTop?.id) => {
    const recorded = seen[conversation.id]
    const state = working.get(conversation.id)
    return (
      <Row
        activity={overview[conversation.id]?.activity}
        assessment={tasks ? currentAssessment(overview[conversation.id]) : undefined}
        concluded={!pinned(conversation) && hiddenIds.has(conversation.id)}
        root={roots.has(conversation.id)}
        conversation={conversation}
        draft={conversation.inputAt === undefined}
        feature={overview[conversation.id]?.feature}
        key={conversation.id}
        now={now}
        onConclude={(conclude) => void requestConclude(conversation.id, conclude)}
        shown={shown}
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
    const ownBranches = (branchesBySource.get(conversation.id) ?? []).filter(
      (branch) => hiddenIds.has(branch.id) === concluded,
    )
    // A root's tree folds away completely, its sub-agents with its branches; its row then stands for the shown branch.
    // Without branches its sub-agents are all of the tree, and their own disclosure folds it.
    const treeBranches =
      !nested && roots.has(conversation.id) ? branchesBelow(conversation.id, concluded) : []
    const folded = treeBranches.length > 0 && collapsedRoots.includes(conversation.id)
    const subagents = children.length > 0 && (
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
    )
    const branches = !nested && ownBranches.length > 0 && (
      <div className="ml-4 border-l border-border/60" data-branches-of={conversation.id}>
        {ownBranches.map((branch) => tree(branch, false, concluded))}
      </div>
    )
    return (
      <div key={conversation.id}>
        {nested ? (
          <ChildRow
            conversation={conversation}
            row={overview[conversation.id]}
            shown={shownId === conversation.id}
          />
        ) : (
          row(
            conversation,
            conversation.id === shownTop?.id ||
              (folded && treeBranches.some((branch) => branch.id === shownTop?.id)),
          )
        )}
        {treeBranches.length > 0 ? (
          <Collapsible
            open={!folded}
            onOpenChange={(next) =>
              setCollapsedRoots((previous) => [
                ...previous.filter((id) => id !== conversation.id),
                ...(next ? [] : [conversation.id]),
              ])
            }
          >
            <CollapsibleTrigger
              aria-label={`Branches of root ${conversation.id}`}
              className="group/branches ml-5 flex cursor-pointer items-center gap-1 py-1 text-[10.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/branches:rotate-90" />
              Branches · {treeBranches.length}
            </CollapsibleTrigger>
            <CollapsibleContent>
              {subagents}
              {branches}
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <>
            {subagents}
            {branches}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col pb-2">
      <Dialog
        open={!!warning}
        onOpenChange={(open) => {
          if (!open) setWarning(undefined)
        }}
      >
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
          <div className="px-5 pt-5 pb-4">
            <DialogTitle className="text-[14px] font-medium">Conclude #{warning?.id}?</DialogTitle>
            <DialogDescription className="mt-2 text-[13px] leading-relaxed break-words">
              {warning?.failure ? (
                <>
                  Couldn't check #{warning.id}'s checkout: {warning.failure}. Conclude anyway?
                </>
              ) : (
                <>
                  {warning?.work
                    ?.map((item) => {
                      const parts = [
                        item.uncommitted > 0
                          ? `${item.uncommitted} uncommitted ${item.uncommitted === 1 ? 'file' : 'files'}`
                          : undefined,
                        item.unlanded > 0
                          ? `${item.unlanded} unlanded ${item.unlanded === 1 ? 'commit' : 'commits'}`
                          : undefined,
                      ].filter(Boolean)
                      return `#${item.id}${item.id !== warning.id ? ', a subagent,' : ''} has ${parts.join(' and ')}.`
                    })
                    .join(' ')}{' '}
                  Its checkout is kept until that work lands or is discarded.
                </>
              )}
            </DialogDescription>
            {error && <p className="mt-3 font-mono text-[12px] break-words text-error">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
            <Button onClick={() => setWarning(undefined)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={pending}
              size="sm"
              onClick={async () => {
                if (!warning) return
                setPending(true)
                try {
                  await setConclude(warning.id, true)
                  setWarning(undefined)
                } catch (failure) {
                  setError(errorMessage(failure))
                } finally {
                  setPending(false)
                }
              }}
            >
              {pending ? 'Concluding…' : 'Conclude'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <div className="mb-1 flex h-10 shrink-0 items-center gap-2 border-b border-border/70 pr-1.5 pl-4 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Conversations
        {workspacesEnabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Workspaces"
                className="ml-auto size-7 cursor-pointer text-muted-foreground hover:text-foreground"
                onClick={() => actions.openPanel('workspaces')}
                size="icon"
                variant="ghost"
              >
                <GitBranchIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Workspaces</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Talk to @ultimate"
              className={cn(
                'size-7 cursor-pointer text-muted-foreground hover:text-foreground',
                !workspacesEnabled && 'ml-auto',
              )}
              onClick={() => void talkToUltimate(actions)}
              size="icon"
              variant="ghost"
            >
              <MessageCircleIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Talk to @ultimate</TooltipContent>
        </Tooltip>
      </div>
      <nav aria-label="Conversations" className="flex flex-col gap-px">
        {landers.length > 0 && (
          <div className="mb-1 flex flex-col gap-px border-b border-border/60 pb-1">
            {landers.map((conversation) => tree(conversation))}
          </div>
        )}
        {rootRows.map((root) => tree(root))}
        {listed
          .filter(
            (conversation) =>
              conversation.branchOf &&
              !roots.has(conversation.id) &&
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
            <CollapsibleTrigger className="group/concluded flex w-full cursor-pointer items-center gap-1 px-4 py-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/concluded:rotate-90" />
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
                    roots.has(conversation.id) ||
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
