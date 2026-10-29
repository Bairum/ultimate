import type { EntryRecord } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import { GitBranchIcon, ListTreeIcon, RotateCcwIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import {
  defineWebExtension,
  useAction,
  useConversation,
  useConversations,
  useDocOf,
  useThreadFocus,
  useThreadLanes,
  useTranscript,
} from '@/sdk'
import type { CompactDocs, LaneProps } from '@/sdk'
import { featureHue, FeatureTag, useOverview } from '../conversations/ui.tsx'
import { AbstractAction } from '../lineage/ui.tsx'
import { MessagesDoc } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { StandingDoc } from '../subagents/ui.tsx'
import { threadsOf } from './threads.tsx'
import type { Thread } from './threads.tsx'

/** The lane and chip colours, in `featureHue`'s order, so a thread matches its feature tag. */
const strokes = [
  'bg-sky-500',
  'bg-teal-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-orange-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-indigo-500',
]
/** A thread's colour: its feature's hue, else one from its id. */
const strokeOf = (feature: string | undefined, id: number) =>
  strokes[feature ? featureHue(feature) : id % strokes.length]

const isUltimate = (id: number | undefined, standing: unknown) =>
  id !== undefined && (standing as { ultimate?: unknown } | null | undefined)?.ultimate === id
const messagesOf = (docs: CompactDocs) =>
  (docs.board as { messages?: Message[] } | null | undefined)?.messages ?? []

/** @ultimate's threads over the entries loaded: one per branch it talked with. */
function useThreads() {
  const id = useConversation((conversation) => conversation.id)
  const standing = useDocOf(1, StandingDoc)
  const log = useDocOf(1, MessagesDoc)
  const entries = useTranscript()
  if (!isUltimate(id, standing)) return undefined
  return threadsOf(entries, log?.messages ?? [], id!)
}

/** One thread's column beside a row: a line while it runs past, a dot on its rows, a ring where it landed. */
function Lane({ thread, here, up, down }: LaneProps) {
  const feature = useOverview()[thread]?.feature
  const stroke = strokeOf(feature, thread)
  return (
    <>
      {(up || down) && (
        <span
          className={cn(
            'absolute left-1/2 w-px -translate-x-1/2 opacity-60',
            stroke,
            up ? 'top-0' : 'top-3',
            down ? 'bottom-0' : 'h-3',
          )}
        />
      )}
      {here && (
        <span
          className={cn(
            'absolute top-2.5 left-1/2 size-2 -translate-x-1/2 rounded-full ring-2 ring-background',
            down || up ? stroke : cn(stroke, 'opacity-90'),
          )}
        />
      )}
    </>
  )
}

/** Where a thread stands, in a word: landed, working, or waiting on @ultimate or you. */
function useStanding(thread: Thread) {
  const busy = useConversations().find((conversation) => conversation.id === thread.id)?.busy
  if (thread.landed) return { word: 'landed', tone: 'text-success' }
  if (busy) return { word: 'working', tone: 'text-brand' }
  return { word: 'idle', tone: 'text-muted-foreground/70' }
}

function Chip({
  thread,
  active,
  onClick,
}: {
  thread: Thread
  active: boolean
  onClick: () => void
}) {
  const overview = useOverview()[thread.id]
  const title = useConversations().find((conversation) => conversation.id === thread.id)?.title
  const { word, tone } = useStanding(thread)
  return (
    <button
      aria-pressed={active}
      className={cn(
        'flex max-w-56 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors',
        active
          ? 'border-border bg-accent text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
      data-thread-chip={thread.id}
      onClick={onClick}
      title={`${title ?? `#${thread.id}`} · ${word}`}
      type="button"
    >
      <span
        className={cn('size-1.5 shrink-0 rounded-full', strokeOf(overview?.feature, thread.id))}
      />
      {overview?.feature ? (
        <FeatureTag className="max-w-28" feature={overview.feature} />
      ) : (
        <span className="min-w-0 truncate">{title ?? `#${thread.id}`}</span>
      )}
      <span className={cn('shrink-0', tone)}>{word}</span>
    </button>
  )
}

/** How many threads the bar lists: the live ones, then the latest landed. */
const SHOWN = 6

/**
 * Above @ultimate's composer: its threads as chips. One click focuses the transcript on that thread, so it reads as
 * one feature's conversation; All returns to everything. Lanes draws every thread beside the rows instead.
 */
function ThreadBar({ core }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const threads = useThreads()
  const [focus, setFocus] = useThreadFocus(id)
  const [lanes, setLanes] = useThreadLanes()
  if (!threads?.threads.length) return core
  const live = threads.threads.filter((thread) => !thread.landed)
  const landed = threads.threads.filter((thread) => thread.landed).toReversed()
  const shown = [...live.toReversed(), ...landed].slice(0, SHOWN)
  const focused = threads.threads.find((thread) => thread.id === focus)
  if (focused && !shown.includes(focused)) shown.push(focused)
  return (
    <>
      <div
        className="mx-auto flex w-full max-w-[46rem] items-center gap-1 px-3 pb-1.5 font-mono text-[11px] sm:px-6"
        data-thread-bar
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          <button
            aria-pressed={!focused}
            className={cn(
              'shrink-0 cursor-pointer rounded-full border px-2 py-0.5 transition-colors',
              !focused
                ? 'border-border bg-accent text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setFocus(null)}
            type="button"
          >
            All
          </button>
          {shown.map((thread) => (
            <Chip
              active={thread.id === focused?.id}
              key={thread.id}
              onClick={() => setFocus(thread.id === focused?.id ? null : thread.id)}
              thread={thread}
            />
          ))}
        </div>
        <button
          aria-pressed={lanes}
          className={cn(
            'flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 transition-colors',
            lanes ? 'text-brand' : 'text-muted-foreground/70 hover:text-foreground',
          )}
          data-thread-lanes
          onClick={() => setLanes(!lanes)}
          title={lanes ? 'Hide the lanes' : 'Show each feature as a lane beside the conversation'}
          type="button"
        >
          <ListTreeIcon className="size-3" />
          lanes
        </button>
      </div>
      {core}
    </>
  )
}

/**
 * Under a landing in @ultimate's conversation: the feature's catch-up, its abstract frozen at landing, so the reader
 * gets where it ended without opening the branch; and the way back to the whole conversation when it is focused.
 */
function CatchUp({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const id = useConversation((conversation) => conversation.id)
  const standing = useDocOf(1, StandingDoc)
  const outcome = (entry.data as { outcome?: { outcome?: string; conversationId?: number } })
    ?.outcome
  const branch = outcome?.outcome === 'landed' ? outcome.conversationId : undefined
  const show = isUltimate(id, standing) && branch !== undefined && branch !== id
  const abstract = useAction(
    AbstractAction,
    { id: branch ?? 0 },
    { enabled: show, onError: () => undefined },
  )
  const [focus, setFocus] = useThreadFocus(id)
  if (!show) return core
  const text = abstract.data?.text
  return (
    <div className="flex flex-col gap-1.5">
      {core}
      {text && (
        <section
          className="rounded-md border border-border/60 bg-muted/10 px-3 py-2"
          data-thread-catchup={branch}
        >
          <header className="mb-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <GitBranchIcon className="size-3 text-success" />
            catch-up
            {abstract.data?.feature && <FeatureTag feature={abstract.data.feature} />}
            <span className="min-w-0 truncate">{abstract.data?.title}</span>
            {focus === branch && (
              <button
                className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 hover:text-foreground"
                onClick={() => setFocus(null)}
                type="button"
              >
                <RotateCcwIcon className="size-3" />
                back to all
              </button>
            )}
          </header>
          <div className="text-[13px] leading-relaxed text-foreground/85 [&_li]:my-0 [&_ul]:my-1">
            <MessageResponse>{text}</MessageResponse>
          </div>
        </section>
      )}
    </div>
  )
}

export default defineWebExtension({
  composer: ThreadBar,
  entries: { 'workspaces.lander-report': CatchUp },
  compact: {
    when: (conversation, docs) => isUltimate(conversation.id, docs[StandingDoc.kind]),
    docs: ['board', StandingDoc.kind],
    threads: (entries, docs, conversation) => threadsOf(entries, messagesOf(docs), conversation).of,
    lane: Lane,
  },
})
