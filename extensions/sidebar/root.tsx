import { ChevronRightIcon, EllipsisIcon, FoldVerticalIcon, MessageCircleIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  api,
  cn,
  events,
  formatTokens,
  Provided,
  useAction,
  useDocOf,
  useEvents,
  useUltimate,
} from '@/sdk'
import { Committed } from '../coding-tools/ui.tsx'
import { BoardDoc, conversationState, emptyBoard } from '../board/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { CompactAction, RecentAction, TallyDoc } from '../lineage/ui.tsx'
import type { RootEvent } from '../lineage/types.ts'
import { CommitCount, ProgressAction, Review, useWorkspaceIndex } from '../workspaces/ui.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import {
  AgentMark,
  ConversationPhase,
  FeatureTag,
  useOverview,
  usePrimaryAgent,
} from '../conversations/ui.tsx'
import { ago } from './lander.tsx'
import { useSidebarState } from './state.tsx'
import { workOf } from './work.ts'
import type { Work } from './work.ts'

type Landing = Extract<RootEvent, { type: 'landed' }>
type Actions = Pick<ReturnType<typeof useUltimate>, 'switchConversation' | 'showSurface'>

/** Opens `conversation` at `entry` on the Agent surface. */
function openEntry(actions: Actions, conversation: number, entry: number) {
  events.emit('board:open', { conversation, entry })
  actions.showSurface('agent')
  actions.switchConversation(conversation)
}

/** When a branch last landed: its latest landed submission's last step. */
export function landedAt(index: ReturnType<typeof useWorkspaceIndex>, id: number) {
  let at: number | undefined
  for (const result of Object.values(index.results))
    if (result.conversationId === id && result.outcome === 'landed')
      at = Math.max(at ?? 0, result.steps.at(-1)?.at ?? result.at)
  return at
}

/**
 * Whether a branch is still in flight: started and neither concluded (the caller leaves those out) nor landed since
 * its latest input. A branch that lands and then gets new work is in flight again.
 */
export function inFlight(
  conversation: ConversationSummary,
  index: ReturnType<typeof useWorkspaceIndex>,
) {
  if (conversation.busy) return true
  if (index.queue.some((item) => item.conversationId === conversation.id)) return true
  const landed = landedAt(index, conversation.id)
  return landed === undefined || (conversation.inputAt ?? 0) > landed
}

/** Where an open branch stands, in a word or two, and how loud to say it. */
function useBranchState(
  conversation: ConversationSummary,
  working: boolean,
  phase: { word: string; waiting: boolean } | undefined,
  parked = false,
) {
  const index = useWorkspaceIndex()
  const board = useDocOf(1, BoardDoc) ?? emptyBoard
  const runState = useOverview()[conversation.id]?.runState
  const name = usePrimaryAgent()
  const standing = useDocOf(1, StandingDoc)
  const primary = name ? standing?.[name] : undefined
  const queued = index.queue.find((item) => item.conversationId === conversation.id)
  if (queued?.state === 'landing') return { label: 'landing', tone: 'success' } as const
  if (queued) return { label: 'submitted', tone: 'success' } as const
  // A pause holds its run: nothing of it executes until Play.
  if (parked) return { label: 'paused', tone: 'paused' } as const
  // The sidebar's one conversation state; `working` also counts its subagents' runs.
  const state = working
    ? 'working'
    : conversationState({ id: conversation.id, kind: 'other', runState, primary }, board)
  if (state === 'working')
    return {
      label: phase && !phase.waiting ? phase.word : 'working',
      tone: 'brand',
    } as const
  // A branch's decisions reach you through @ultimate: an open question it asked (an approval, a choice).
  if (state === 'awaiting') return { label: 'awaiting @ultimate', tone: 'waiting' } as const
  if (state === 'failed') return { label: 'failed', tone: 'failed' } as const
  return { label: 'idle', tone: 'quiet' } as const
}

const tones = {
  failed: 'text-error',
  success: 'text-success',
  brand: 'text-brand',
  waiting: 'text-amber-700 dark:text-amber-300',
  paused: 'text-warning',
  quiet: 'text-muted-foreground/70',
}

type FlightProps = {
  conversation: ConversationSummary
  working: boolean
  /** A pause parked its run. */
  parked?: boolean
  shown: boolean
  now: number
  work?: Work
}

/** Uncommitted edits as "+ 4 edits", opening a review of them while something reviews. */
function Edits({ count, spec }: { count: number; spec: string }) {
  const label = `+ ${count} edit${count === 1 ? '' : 's'}`
  return (
    <Provided input={spec} point={Review}>
      {(open) =>
        open ? (
          <button
            className="shrink-0 cursor-pointer hover:text-foreground hover:underline"
            onClick={open}
            title="Review uncommitted changes"
            type="button"
          >
            {label}
          </button>
        ) : (
          <span className="shrink-0">{label}</span>
        )
      }
    </Provided>
  )
}

/** One open branch: its feature and title, where it stands, and its age; click opens it. */
function FlightRow(props: FlightProps) {
  return (
    <Provided input={props.working ? props.conversation.id : undefined} point={ConversationPhase}>
      {(phase) => <PhasedFlightRow {...props} phase={phase} />}
    </Provided>
  )
}

function PhasedFlightRow({
  conversation,
  working,
  parked,
  shown,
  now,
  work,
  phase,
}: FlightProps & { phase?: { word: string; waiting: boolean } }) {
  const actions = useUltimate()
  const feature = useOverview()[conversation.id]?.feature
  const state = useBranchState(conversation, working, phase, parked)
  const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
  const title = conversation.title ?? `#${conversation.id}`
  return (
    <li className="relative">
      <button
        aria-current={shown ? 'true' : undefined}
        className={cn(
          'flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-sm py-1 pr-2 pl-[42px] text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
          shown && 'bg-sidebar-accent',
        )}
        data-in-flight={conversation.id}
        onClick={() => actions.switchConversation(conversation.id)}
        title={`${title} · #${conversation.id}`}
        type="button"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              state.tone === 'brand'
                ? 'animate-pulse-dot bg-brand'
                : state.tone === 'waiting' || state.tone === 'paused'
                  ? 'bg-amber-400'
                  : state.tone === 'success'
                    ? 'bg-success'
                    : state.tone === 'failed'
                      ? 'bg-error'
                      : 'bg-muted-foreground/40',
            )}
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[12px]',
              shown ? 'text-foreground' : 'text-foreground/85',
            )}
          >
            {title}
          </span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 pl-3 font-mono text-[10px] leading-4 text-muted-foreground">
          {feature && <FeatureTag feature={feature} />}
          <span className={cn('shrink-0', tones[state.tone])}>{state.label}</span>
          {latest > 0 && (
            <span className="ml-auto shrink-0 pl-1 text-muted-foreground/60">
              {ago(latest, now)}
            </span>
          )}
        </span>
      </button>
      {work && (
        // Its own line under the row's button, so its links never nest in it.
        <span
          className="flex min-w-0 items-center gap-2 pr-2 pb-0.5 pl-[54px] font-mono text-[10px] leading-4 text-muted-foreground/80"
          data-flight-work={conversation.id}
        >
          {work.commits && <CommitCount count={work.commits.count} range={work.commits.spec} />}
          {work.edits && <Edits count={work.edits.count} spec={work.edits.spec} />}
        </span>
      )}
    </li>
  )
}

/** A landing as one line: the feature it shipped, its commit count linking the compare range, its age. */
function LandingLine({ event, root, now }: { event: Landing; root: number; now: number }) {
  const actions = useUltimate()
  const label = event.feature ?? event.title
  return (
    <li
      className="flex h-5 min-w-0 items-center gap-1.5 rounded-sm pr-2 pl-[42px] font-mono text-[10.5px] text-muted-foreground hover:bg-sidebar-accent/60"
      data-root-event="landed"
    >
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => openEntry(actions, root, event.entry)}
        title={[event.feature, event.title, `Open #${root}/${event.entry}`]
          .filter(Boolean)
          .join(' · ')}
        type="button"
      >
        {event.feature ? (
          <FeatureTag className="max-w-full" feature={event.feature} />
        ) : (
          <span className="truncate font-sans text-[11.5px] text-foreground/80">
            {label ?? event.sha.slice(0, 7)}
          </span>
        )}
      </button>
      <CommitCount
        className="text-muted-foreground/80"
        count={event.commits}
        href={event.compare}
        range={event.base ? `${event.base}...${event.sha}` : undefined}
      />
      {event.at !== undefined && (
        <span className="w-6 shrink-0 text-right text-muted-foreground/60">
          {ago(event.at, now)}
        </span>
      )}
    </li>
  )
}

/**
 * Each open branch's work so far, read once for all of them. It is read again only when something can have changed it:
 * an agent commits (`coding-tools.committed`), a worktree changes in the index, or a branch's run starts or ends
 * (edits happen in runs). Never on a timer.
 */
function useFlightWork(branches: ConversationSummary[]) {
  const ids = branches.filter((branch) => branch.workspace?.state === 'ready').map((b) => b.id)
  const progress = useAction(
    ProgressAction,
    { ids },
    { enabled: ids.length > 0, onError: () => {} },
  )
  const { refetch } = progress
  // A worktree becoming ready or going changes `ids`, which refetches by itself.
  const commit = useEvents({ events: [Committed], limit: 1 })?.[0]?.id
  const runs = branches.map((branch) => `${branch.id}:${branch.busy ? 1 : 0}`).join(',')
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (ids.length > 0) void refetch()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a changed id set refetches in useAction itself
  }, [commit, runs, refetch])
  const byId = new Map((progress.data ?? []).map((item) => [item.id, item]))
  return new Map(
    branches.map((branch) => [
      branch.id,
      workOf(branch.id, branch.workspace?.branch, byId.get(branch.id)),
    ]),
  )
}

/** A section's quiet heading, as a fold toggle when it folds. */
const heading =
  'flex w-full items-center gap-1 pt-1 pb-0.5 pl-[42px] font-mono text-[9.5px] tracking-wider text-muted-foreground/70 uppercase'

/**
 * The head of a tree as a small dashboard: the context every branch starts from, what is in flight (open branches
 * with their feature, state and age) and what landed (feature, commit count linking the compare range on GitHub, age),
 * folded to the last few. Notes, new branches and compactions stay on the root's page. A root is never concluded or
 * cleared; its menu compacts the context or opens @ultimate, who keeps it.
 */
export function RootRow({
  conversation,
  shown,
  shownId,
  working,
  flights,
  now,
  onTalk,
}: {
  conversation: ConversationSummary
  shown: boolean
  shownId?: number
  working?: 'self' | 'subagents'
  /** Open branches of this tree, newest first, with whether each works. */
  flights: { conversation: ConversationSummary; working: boolean; parked?: boolean }[]
  now: number
  onTalk: () => void
}) {
  const actions = useUltimate()
  const id = conversation.id
  const tally = useDocOf(id, TallyDoc)
  const [unfolded, setUnfolded] = useSidebarState<number[]>('landingsOpen', [])
  const more = unfolded.includes(id)
  const landings = useAction(
    RecentAction,
    { id, types: ['landed'], limit: 10 },
    { onError: () => {} },
  )
  const { refetch } = landings
  // Every entry the root gets recounts its tokens: a new count means something may have landed.
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
  // Asked for landings only.
  const landed = (landings.data ?? []) as Landing[]
  const shownLandings = more ? landed : landed.slice(0, 3)
  // The root's own landing notes count too: the lander keeps only recent results.
  const open = flights.filter(
    (flight) =>
      flight.working ||
      !landed.some(
        (event) =>
          event.from === flight.conversation.id &&
          (event.at ?? 0) >= (flight.conversation.inputAt ?? 0),
      ),
  )
  const work = useFlightWork(open.map((flight) => flight.conversation))
  return (
    <div
      className={cn(
        'group relative mx-2 rounded-md pb-1 transition-colors',
        shown ? 'bg-sidebar-accent/60' : 'hover:bg-sidebar-accent/30',
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
        <AgentMark name="root" presence={working === 'self' ? 'working' : undefined} />
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
      {open.length > 0 && (
        <section aria-label={`In flight in ${name}`}>
          <h3 className={heading}>In flight · {open.length}</h3>
          <ul className="flex flex-col">
            {open.map((flight) => (
              <FlightRow
                conversation={flight.conversation}
                key={flight.conversation.id}
                now={now}
                parked={flight.parked}
                shown={flight.conversation.id === shownId}
                work={work.get(flight.conversation.id)}
                working={flight.working}
              />
            ))}
          </ul>
        </section>
      )}
      {landed.length > 0 && (
        <section aria-label={`Landed in ${name}`}>
          {landed.length > 3 ? (
            <button
              aria-expanded={more}
              className={cn(heading, 'cursor-pointer outline-none hover:text-foreground')}
              onClick={() =>
                setUnfolded((previous) => [
                  ...previous.filter((root) => root !== id),
                  ...(more ? [] : [id]),
                ])
              }
              type="button"
            >
              Landed
              <ChevronRightIcon
                className={cn('size-2.5 transition-transform', more && 'rotate-90')}
              />
              <span className="normal-case">{more ? 'fewer' : `${landed.length - 3} more`}</span>
            </button>
          ) : (
            <h3 className={heading}>Landed</h3>
          )}
          <ul className="flex flex-col">
            {shownLandings.map((event) => (
              <LandingLine event={event} key={event.entry} now={now} root={id} />
            ))}
          </ul>
        </section>
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
            disabled={tally?.since === undefined || working === 'self'}
            onSelect={() => void api.action(CompactAction, { id })}
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
