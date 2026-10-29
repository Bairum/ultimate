import { cn } from 'cn'
import { GitBranchIcon, MessageSquareIcon, XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import {
  api,
  Composer,
  ComposerRedirect,
  defineWebExtension,
  formatAgo,
  provide,
  ThreadView,
  useAction,
  useConversation,
  useConversations,
  useDocOf,
  useNow,
  useTranscript,
  useUiState,
} from '@/sdk'
import type { CompactDocs, EntryRecord } from '@/sdk'
import { FeatureTag, useOverview } from '../conversations/ui.tsx'
import { AbstractAction } from '../lineage/ui.tsx'
import { MessagesDoc } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { StandingDoc } from '../subagents/ui.tsx'
import { LandingAfter } from '../workspaces/ui.tsx'
import { reply, threading, threadsOf } from './threads.tsx'
import type { Thread } from './threads.tsx'

const isUltimate = (id: number | undefined, standing: unknown) =>
  id !== undefined && (standing as { ultimate?: unknown } | null | undefined)?.ultimate === id
const messagesOf = (docs: CompactDocs) =>
  (docs.board as { messages?: Message[] } | null | undefined)?.messages ?? []

/** The thread open in the side pane, if any; durable UI state, so a reload keeps it open. */
const useOpenThread = () => useUiState<number | null>('ext.threads.open', null)
/** The newest entry of each thread the reader has seen, by thread: a newer one marks the root unread. */
const useSeen = () => useUiState<Record<string, number>>('ext.threads.seen', {})

/** @ultimate's threads over the entries loaded: one per branch it talked with. */
function useThreads() {
  const id = useConversation((conversation) => conversation.id)
  const standing = useDocOf(1, StandingDoc)
  const log = useDocOf(1, MessagesDoc)
  const entries = useTranscript()
  if (!isUltimate(id, standing)) return undefined
  return { entries, threads: threadsOf(entries, log?.messages ?? [], id!) }
}

/** Where a thread stands, in a word, and its tone. */
function useStanding(thread: Thread) {
  const conversation = useConversations().find((item) => item.id === thread.id)
  const log = useDocOf(1, MessagesDoc)
  const asks = log?.messages.some(
    (m) => m.to === 'user' && m.reply && m.state === 'delivered' && thread.asks?.includes(m.id),
  )
  if (thread.landed) return { word: 'landed', tone: 'text-success' }
  if (asks) return { word: 'waiting on you', tone: 'text-amber-700 dark:text-amber-300' }
  if (conversation?.busy) return { word: 'working', tone: 'text-brand' }
  return { word: 'idle', tone: 'text-muted-foreground/70' }
}

/** A thread's entries that say something: messages in and out, answers, landings; not tool steps. */
function said(
  entries: readonly EntryRecord[],
  of: ReadonlyMap<number, readonly number[]>,
  id: number,
) {
  return entries.filter((entry) => {
    if (!of.get(entry.id)?.includes(id)) return false
    if (entry.kind === 'pi.tool-result') return false
    const message = entry.model?.[0]
    if (message?.role === 'assistant')
      return message.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'toolCall' && block.name === 'message'),
      )
    return true
  })
}

/** The first line a thread's newest entry says, for its root row. */
function firstLine(entry: EntryRecord | undefined): string {
  if (!entry) return ''
  const data = entry.data as
    | { text?: unknown; outcome?: { outcome?: string; sha?: string } }
    | undefined
  if (entry.kind === 'workspaces.lander-report')
    return data?.outcome?.outcome === 'landed'
      ? `Landed ${data.outcome.sha?.slice(0, 7)}`
      : 'Landing failed'
  if (typeof data?.text === 'string') return data.text
  const message = entry.model?.[0]
  if (message?.role === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'toolCall' && block.name === 'message') {
        const text = (block.arguments as { text?: unknown }).text
        if (typeof text === 'string') return text
      }
      if (block.type === 'text' && block.text.trim()) return block.text
    }
  }
  if (message?.role === 'user')
    return typeof message.content === 'string'
      ? message.content
      : (message.content.find((block) => block.type === 'text')?.text ?? '')
  return ''
}
const oneLine = (text: string) =>
  text
    .replace(/^Re #\d+: /, '')
    .replace(/[*_`#>]/g, '')
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? ''

const timeOf = (entry: EntryRecord | undefined) => {
  const at = entry?.model?.[0]?.timestamp
  return typeof at === 'number' ? at : undefined
}

/**
 * A thread's root in @ultimate's main stream, like a chat app's "N replies" row: the feature, where it stands, the
 * newest reply's first line, how many, and when it last moved. Click opens the thread beside the conversation.
 */
function ThreadRoot({ entry }: { entry: EntryRecord }) {
  const id = (entry.data as { thread: number }).thread
  const found = useThreads()
  const [open, setOpen] = useOpenThread()
  const [seen, setSeen] = useSeen()
  const now = useNow(30_000)
  const overview = useOverview()[id]
  const title = useConversations().find((item) => item.id === id)?.title
  const thread = found?.threads.threads.find((item) => item.id === id)
  if (!found || !thread) return null
  const replies = said(found.entries, found.threads.of, id)
  const newest = replies.at(-1)
  const unread = !!newest && newest.id > (seen[String(id)] ?? 0) && open !== id
  const at = timeOf(newest)
  return (
    <button
      className={cn(
        'group flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors',
        open === id ? 'border-brand/50 bg-accent/60' : 'border-border/70 hover:bg-accent/40',
      )}
      data-thread-root={id}
      data-unread={unread || undefined}
      onClick={() => {
        setOpen(open === id ? null : id)
        if (newest) setSeen((value) => ({ ...value, [id]: newest.id }))
      }}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <MessageSquareIcon className="size-3 shrink-0" />
        {overview?.feature && <FeatureTag feature={overview.feature} />}
        <span className="min-w-0 truncate text-foreground/85">{title ?? `#${id}`}</span>
        <Standing thread={thread} />
        {unread && <span className="size-1.5 shrink-0 rounded-full bg-brand" />}
      </span>
      <span className="truncate text-[13px] text-foreground/80">{oneLine(firstLine(newest))}</span>
      <span className="font-mono text-[11px] text-brand/80">
        {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        {at !== undefined && (
          <span className="text-muted-foreground/70"> · {formatAgo(at, now)}</span>
        )}
      </span>
    </button>
  )
}

function Standing({ thread }: { thread: Thread }) {
  const { word, tone } = useStanding(thread)
  return <span className={cn('ml-auto shrink-0', tone)}>{word}</span>
}

/** The open thread beside @ultimate's conversation: its messages, and a composer whose words go to @ultimate about it. */
function ThreadPane() {
  const id = useConversation((conversation) => conversation.id)
  const standing = useDocOf(1, StandingDoc)
  const [open, setOpen] = useOpenThread()
  const title = useConversations().find((item) => item.id === open)?.title
  const overview = useOverview()[open ?? 0]
  if (!isUltimate(id, standing) || open === null) return null
  return (
    <aside
      aria-label="Thread"
      className="absolute top-3 right-4 bottom-3 z-10 flex w-[min(30rem,40%)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl shadow-black/30"
      data-thread-pane={open}
    >
      <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MessageSquareIcon className="size-3" />
        Thread
        {overview?.feature && <FeatureTag feature={overview.feature} />}
        <span className="min-w-0 truncate text-foreground/85">{title ?? `#${open}`}</span>
        <button
          aria-label="Close thread"
          className="ml-auto cursor-pointer rounded-sm p-0.5 hover:bg-accent hover:text-foreground"
          onClick={() => setOpen(null)}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </header>
      <ThreadView thread={open}>
        <ComposerRedirect
          to={{
            placeholder: `Reply about #${open}…`,
            send: (text) => api.submit(reply(open, text), 'followUp', id),
          }}
        >
          <Composer dock />
        </ComposerRedirect>
      </ThreadView>
    </aside>
  )
}

/**
 * Under a landing in @ultimate's conversation: the feature's catch-up, its abstract frozen at landing, so the reader
 * gets where it ended without opening the branch.
 */
function useCatchUp({ from: branch }: { from: number; card: number }): ReactNode {
  const id = useConversation((conversation) => conversation.id)
  const standing = useDocOf(1, StandingDoc)
  const show = isUltimate(id, standing) && branch !== id
  const abstract = useAction(
    AbstractAction,
    { id: branch },
    // The landing card says what landed either way; the catch-up only adds to it.
    { enabled: show, onError: () => undefined },
  )
  const text = abstract.data?.text
  if (!show || !text) return null
  return (
    <section
      className="mt-1.5 rounded-md border border-border/60 bg-muted/10 px-3 py-2"
      data-thread-catchup={branch}
    >
      <header className="mb-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <GitBranchIcon className="size-3 text-success" />
        catch-up
        {abstract.data?.feature && <FeatureTag feature={abstract.data.feature} />}
        <span className="min-w-0 truncate">{abstract.data?.title}</span>
      </header>
      {/* An abstract is a few `Label: text` lines (Ask, Diverged, State, Areas, Open): one row each. */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] leading-relaxed">
        {text
          .split('\n')
          .filter((line) => line.trim())
          .map((line, index) => {
            const [, label, rest] = /^-?\s*([A-Z][\w ]{0,15}):\s*(.*)$/.exec(line) ?? []
            return (
              // oxlint-disable-next-line react/no-array-index-key -- the lines of one stored text keep their order.
              <div className="contents" key={index}>
                <dt className="pt-px font-mono text-[11px] text-muted-foreground">{label ?? ''}</dt>
                <dd className="min-w-0 text-foreground/85 [&_p]:my-0">
                  <MessageResponse>{rest ?? line}</MessageResponse>
                </dd>
              </div>
            )
          })}
      </dl>
    </section>
  )
}

export default defineWebExtension({
  slots: { 'conversation.overlay': [ThreadPane] },
  entries: { 'threads.root': ThreadRoot },
  provides: [provide(LandingAfter, useCatchUp)],
  compact: {
    when: (conversation, docs) => isUltimate(conversation.id, docs[StandingDoc.kind]),
    docs: ['board', StandingDoc.kind],
    threads: (entries, docs, conversation) =>
      threading(entries, threadsOf(entries, messagesOf(docs), conversation)),
  },
})
