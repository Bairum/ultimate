import { ChevronRightIcon, EllipsisIcon, FoldVerticalIcon, MessageCircleIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, cn, events, formatTokens, useAction, useDocOf, useUltimate } from '@/sdk'
import { BoardDoc, emptyBoard, isOpen } from '../board/ui.tsx'
import { CompactAction, RecentAction, TallyDoc } from '../lineage/ui.tsx'
import type { RootEvent } from '../lineage/types.ts'
import { phaseText, usePhase } from '../phase/ui.tsx'
import { CommitCount, useWorkspaceIndex } from '../workspaces/ui.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import { AgentMark, FeatureTag, useOverview } from '../conversations/ui.tsx'
import { ago } from './lander.tsx'
import { useSidebarState } from './state.tsx'

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
function useBranchState(conversation: ConversationSummary, working: boolean) {
  const index = useWorkspaceIndex()
  const board = useDocOf(1, BoardDoc) ?? emptyBoard
  const phase = usePhase(working ? conversation.id : undefined)
  const queued = index.queue.find((item) => item.conversationId === conversation.id)
  if (queued?.state === 'landing') return { label: 'landing', tone: 'success' } as const
  if (queued) return { label: 'submitted', tone: 'success' } as const
  if (working)
    return {
      label: phase && phase !== 'waiting' ? phaseText(phase).toLowerCase() : 'working',
      tone: 'brand',
    } as const
  // A branch's decisions reach you through @ultimate: an open question it asked (an approval, a choice) waits on an
  // answer from @ultimate or you.
  if (board.messages.some((message) => message.from === conversation.id && isOpen(message)))
    return { label: 'awaiting reply', tone: 'waiting' } as const
  return { label: 'idle', tone: 'quiet' } as const
}

const tones = {
  success: 'text-success',
  brand: 'text-brand',
  waiting: 'text-amber-700 dark:text-amber-300',
  quiet: 'text-muted-foreground/70',
}

/** One open branch: its feature and title, where it stands, and its age; click opens it. */
function FlightRow({
  conversation,
  working,
  shown,
  now,
}: {
  conversation: ConversationSummary
  working: boolean
  shown: boolean
  now: number
}) {
  const actions = useUltimate()
  const feature = useOverview()[conversation.id]?.feature
  const state = useBranchState(conversation, working)
  const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
  const title = conversation.title ?? `#${conversation.id}`
  return (
    <li>
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
                : state.tone === 'waiting'
                  ? 'bg-amber-400'
                  : state.tone === 'success'
                    ? 'bg-success'
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
      />
      {event.at !== undefined && (
        <span className="w-6 shrink-0 text-right text-muted-foreground/60">
          {ago(event.at, now)}
        </span>
      )}
    </li>
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
  flights: { conversation: ConversationSummary; working: boolean }[]
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
                shown={flight.conversation.id === shownId}
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
