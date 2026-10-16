import {
  ChevronRightIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitForkIcon,
  ScrollTextIcon,
  StickyNoteIcon,
} from 'lucide-react'
import { createContext, use, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Kbd } from '@/components/ui/kbd'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  api,
  cn,
  defineWebExtension,
  formatTime,
  formatTokens,
  getConversation,
  getState,
  getUiState,
  NewConversationComposer,
  useComposer,
  useConversation,
  useDocOf,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { Open } from '../workspaces/landing.tsx'
import { getRoots, useRoots } from './roots.tsx'
import { entryText, openStart, StartPage } from './start.tsx'

type Tally = { abstracts: Record<string, number>; tokens: number; since?: number }
const tallyKind = 'lineage.tally'

function userText(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (message?.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** A branch started from this conversation: in its tree's root a card with the prompt, elsewhere a quiet divider. */
function Branched({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { branch, intent } = entry.data as { branch: number; intent: string }
  if (entry.model) return <Started entry={entry} />
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70 hover:text-foreground"
      data-lineage-branched={branch}
      onClick={() => switchConversation(branch)}
      title={`Open #${branch}`}
      type="button"
    >
      <span className="flex max-w-[70%] min-w-0 items-center gap-1.5">
        <GitForkIcon className="size-3 shrink-0" />
        <span className="shrink-0">Branched →</span>
        <ConversationRef id={branch} title={intent} />
      </span>
    </button>
  )
}

/** The tally's prompt node: which branch started, from where, with what prompt (three lines until opened). */
function Started({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { branch, at, intent, images, from } = entry.data as {
    branch: number
    at: number
    intent: string
    images?: number
    from?: number
  }
  const [open, setOpen] = useState(false)
  const timestamp = entry.model?.[0]?.timestamp
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/50 bg-muted/20"
      data-lineage-started={branch}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <GitForkIcon className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-foreground">Started</span>
        <button
          className="flex min-w-0 cursor-pointer text-foreground hover:underline"
          onClick={() => switchConversation(branch)}
          title={`Open #${branch}`}
          type="button"
        >
          <ConversationRef id={branch} />
        </button>
        {from !== undefined && (
          <button
            className="shrink-0 cursor-pointer hover:text-foreground hover:underline"
            onClick={() => switchConversation(from)}
            title={`Open #${from}`}
            type="button"
          >
            from #{from}/{at}
          </button>
        )}
        {timestamp !== undefined && (
          <time
            className="ml-auto shrink-0 tabular-nums"
            dateTime={new Date(timestamp).toISOString()}
            title={new Date(timestamp).toLocaleString()}
          >
            {formatTime(new Date(timestamp))}
          </time>
        )}
      </header>
      <button
        aria-expanded={open}
        className="block w-full min-w-0 cursor-pointer px-3 py-2.5 text-left text-[13px] leading-relaxed"
        onClick={() => setOpen((current) => !current)}
        title={open ? 'Show less' : 'Show the whole prompt'}
        type="button"
      >
        <span className={cn('block break-words whitespace-pre-wrap', !open && 'line-clamp-3')}>
          {intent}
        </span>
        {!!images && (
          <span className="mt-1.5 block font-mono text-[11px] text-muted-foreground">
            {images} image{images === 1 ? '' : 's'}
          </span>
        )}
      </button>
    </section>
  )
}

/** A conversation's latest abstract in the tally; one a later abstract omits from the context is not shown. */
function Abstract({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { conversation, at, text, title } = entry.data as {
    conversation: number
    at: number
    text: string
    title?: string
  }
  const superseded = useTranscript().some((other) =>
    other.edits?.some((edit) => edit.target === entry.id && edit.action === 'omit'),
  )
  if (superseded) return null
  return (
    <section
      className="min-w-0 rounded-md border border-border bg-muted/20"
      data-lineage-abstract={conversation}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <ScrollTextIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Abstract ·</span>
        <button
          className="flex min-w-0 cursor-pointer text-foreground hover:underline"
          onClick={() => switchConversation(conversation)}
          title={`Open #${conversation}`}
          type="button"
        >
          <ConversationRef id={conversation} title={title} />
        </button>
        <Open className="ml-auto" entry={at} id={conversation} />
      </header>
      <p className="min-w-0 px-3 py-2.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
        {text}
      </p>
    </section>
  )
}

/** A conversation this one asked `notify` about has finished: its title and last answer. */
function Finished({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { from, title, text } = entry.data as { from: number; title?: string; text: string }
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-success/70 bg-muted/20"
      data-lineage-finished={from}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <CircleCheckIcon className="size-3.5 shrink-0 text-success" />
        <button
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-foreground hover:underline"
          onClick={() => switchConversation(from)}
          title={`Open #${from}`}
          type="button"
        >
          <ConversationRef id={from} title={title} />
          <span className="shrink-0">finished</span>
        </button>
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

/** A note between conversations, tinted yellow: as received (`Note from #N`) and as left (`Note → #N`). */
function NoteCard({
  label,
  id,
  text,
  note,
}: {
  label: string
  id?: number | string
  text: string
  note: 'received' | 'left'
}) {
  const { switchConversation } = useUltimate()
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-note/25 border-l-note/60 bg-note/6"
      data-lineage-note={note}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-note/15 px-3 py-2 font-mono text-[11px] text-foreground">
        <StickyNoteIcon className="size-3.5 shrink-0 text-note" />
        {label}
        {typeof id === 'number' ? (
          <button
            className="min-w-0 cursor-pointer hover:underline"
            onClick={() => switchConversation(id)}
            title={`Open #${id}`}
            type="button"
          >
            <ConversationRef id={id} />
          </button>
        ) : (
          id
        )}
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

/** A note another conversation (or the lander, a quiet `notify`, main's catch-up) left here. */
function Note({ entry, core }: { entry: EntryRecord; core: React.ReactNode }) {
  const { from, text, source } = entry.data as {
    from?: number
    text: string
    source?: 'lander' | 'finished' | 'main'
  }
  if (source === 'lander') return core
  if (source === 'finished') return <Finished entry={entry} />
  if (source !== 'main') return <NoteCard id={from} label="Note from" note="received" text={text} />
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/50 bg-muted/20"
      data-lineage-note="main"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-foreground">
        <GitBranchIcon className="size-3.5 text-brand" />
        Main catch-up
      </header>
      <div className="min-w-0 px-3 py-2.5 text-[13px] leading-relaxed">
        <MessageResponse>{text}</MessageResponse>
      </div>
    </section>
  )
}

/** The `note` tool as the note it left; a failed call keeps the generic card with its error. */
function NoteCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  if (call.status === 'error' || call.status === 'interrupted') return core
  const left = /^Left a note in #(\d+)\.$/.exec(call.output)
  const to = left ? Number(left[1]) : call.args.to
  return (
    <NoteCard
      id={typeof to === 'number' ? to : typeof to === 'string' ? to : undefined}
      label="Note →"
      note="left"
      text={typeof call.args.text === 'string' ? call.args.text : ''}
    />
  )
}

/** A branch's brief, which starts its context: collapsible like a compaction. */
function Brief({ entry, lineage }: { entry: EntryRecord; lineage: { from: number; at: number } }) {
  const { switchConversation } = useUltimate()
  const brief = userText(entry)
    .replace(/^<brief[^>]*>\n/, '')
    .replace(/\n<\/brief>$/, '')
  return (
    <Collapsible
      className="group/brief rounded-lg border border-brand/30 bg-brand/5"
      data-lineage-brief={lineage.from}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/brief:rotate-90" />
          Branched from
          <span
            className="cursor-pointer hover:underline"
            onClick={(event) => {
              event.stopPropagation()
              switchConversation(lineage.from)
            }}
            role="link"
          >
            <ConversationRef id={lineage.from} />
          </span>
          · brief
        </span>
        <span className="text-xs text-muted-foreground">
          This conversation starts from a brief of #{lineage.from} up to entry {lineage.at}. Earlier
          messages remain available above.
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <MessageResponse>{brief}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A conversation's history distilled into the start of its tally: collapsible like a brief. */
function Genesis({ entry }: { entry: EntryRecord }) {
  const text = userText(entry)
  const from = /^<tally from="([^"]*)">/.exec(text)?.[1]
  const genesis = text.replace(/^<tally[^>]*>\n/, '').replace(/\n<\/tally>$/, '')
  return (
    <Collapsible
      className="group/genesis rounded-lg border border-brand/30 bg-brand/5"
      data-lineage-genesis={entry.conversationId}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/genesis:rotate-90" />
          Tally starts here{from ? ` · distilled from ${from}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">
          The conversation before this point is distilled into the start of the tally. Earlier
          messages remain available above.
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <MessageResponse>{genesis}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Lineage's resets: a tally's genesis, an old branch's brief, and the empty reset a new tally starts with, which shows
 * nothing.
 */
function Reset({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const roots = useRoots()
  const lineage = (
    entry.data as { lineage?: { tally?: true; from?: number; at?: number } } | undefined
  )?.lineage
  if (lineage?.tally) return <Genesis entry={entry} />
  if (lineage?.from !== undefined && lineage.at !== undefined)
    return <Brief entry={entry} lineage={{ from: lineage.from, at: lineage.at }} />
  if (!entry.model && entry.data === undefined && roots?.includes(entry.conversationId)) return null
  return core
}

/** The root a composer starts branches of; set by `TallyComposer` for its status line. */
const TallyContext = createContext<number | undefined>(undefined)

/** Under the composer: a tally's size, or the start page's keys. */
function ComposerStatus() {
  const tally = use(TallyContext)
  const { target } = useComposer()
  if (tally !== undefined) return <TallyTokens id={tally} />
  return target === 'new' ? (
    <span className="text-muted-foreground/70 pointer-coarse:hidden">
      <Kbd>↵</Kbd> start · <Kbd>esc</Kbd> close
    </span>
  ) : null
}

function TallyTokens({ id }: { id: number }) {
  const tokens = useDocOf<Tally>(id, tallyKind)?.tokens
  return (
    <span className="text-muted-foreground/70" data-lineage-tokens={tokens}>
      Tally{tokens === undefined ? '' : ` · ${formatTokens(tokens)} tokens`}
    </span>
  )
}

/** A root's composer starts a branch from its tip; other conversations keep theirs. */
function RootComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const roots = useRoots()
  if (id === undefined || !roots?.includes(id)) return core
  return <TallyComposer core={core} dock={dock} id={id} key={id} />
}

/**
 * Only a root subscribes to its `lineage.tally` document. A root with history that is no tally yet (made a root before
 * tallies existed) keeps its own composer until "Make this a root" converts it.
 */
function TallyComposer({ id, core, dock }: { id: number; core: ReactNode; dock?: boolean }) {
  const { switchConversation } = useUltimate()
  const tally = useDocOf<Tally>(id, tallyKind)
  const history = useConversation(
    (conversation) => !conversation.loading && conversation.entries.length > 0,
  )
  if (tally !== undefined && tally?.since === undefined && history) return core
  return (
    <TallyContext value={id}>
      <NewConversationComposer
        branch={{ from: id }}
        dock={dock}
        onStarted={switchConversation}
        placeholder="Start a branch from this tally…"
      />
    </TallyContext>
  )
}

function BranchAction({ entry }: { entry: EntryRecord }) {
  return (
    <button
      aria-label="Branch from here"
      title="Branch from here"
      className="cursor-pointer rounded p-0.5 transition-colors hover:text-foreground"
      onClick={() =>
        openStart({ from: entry.conversationId, at: entry.id }, { excerpt: entryText(entry) })
      }
      type="button"
    >
      <GitBranchIcon className="size-3" />
    </button>
  )
}

/** Keeps the roots streaming, for the synchronous `when` of "Make this a root". */
function Roots() {
  useRoots()
  return null
}

/** The shown conversation, when it is top-level (not a subagent or other owned conversation) and not a branch. */
function topLevel() {
  const { id } = getConversation()
  const summary = getState().conversations.find((conversation) => conversation.id === id)
  return id !== undefined && summary?.parentConversationId === undefined && !summary?.branchOf
}

/**
 * Whether the shown conversation is a tally, or a root that becomes one with its first branch; undefined while unknown.
 * A root's composer keeps its `lineage.tally` document streaming.
 */
function shownIsTally() {
  const { id, entries, loading } = getConversation()
  const roots = getRoots()
  if (id === undefined || !roots) return undefined
  if (!roots.includes(id)) return false
  const doc = getState().docsOf[id]?.[tallyKind] as Tally | null | undefined
  if (doc === undefined || loading) return undefined
  return doc?.since !== undefined || entries.length === 0
}

/** Where a branch starts by default: the shown tree's root, else the most recently active root. */
async function defaultRoot() {
  const { id } = getConversation()
  const info = await api.action<{ roots: number[]; root?: number }>(
    'lineage',
    'info',
    id === undefined ? null : { id },
  )
  if (info.root !== undefined) return info.root
  const { conversations } = getState()
  const inputAt = (root: number) =>
    conversations.find((conversation) => conversation.id === root)?.inputAt ?? 0
  return info.roots.toSorted((a, b) => inputAt(b) - inputAt(a) || b - a)[0]
}

export default defineWebExtension({
  start: async ({ root, ...draft }) => {
    // The preference isolates only where the project can be isolated; an explicit choice is passed on as is.
    const isolated =
      draft.isolated ??
      (getUiState('ext.conversations.creationType') !== 'shared' &&
        getState().system?.extensions.some((extension) => extension.name === 'workspaces') ===
          true &&
        !(await api.action<{ reason?: string }>('workspaces', 'isolation', {})).reason)
    if (root) {
      const { from: _from, at: _at, ...input } = draft
      return api.action<{ id: number; root: number }>('lineage', 'newRoot', { ...input, isolated })
    }
    const from = draft.from ?? (await defaultRoot())
    if (from === undefined) throw new Error('There is no root to branch from')
    return api.action<{ id: number }>('lineage', 'branch', { ...draft, from, isolated })
  },
  tools: { note: NoteCall },
  entries: {
    'lineage.branched': Branched,
    'lineage.note': Note,
    'lineage.finished': Finished,
    'lineage.abstract': Abstract,
    'pi.reset': Reset,
  },
  composer: RootComposer,
  slots: {
    'composer.status': [ComposerStatus],
    'conversation.overlay': [StartPage],
    overlay: [Roots],
  },
  messageActions: [BranchAction],
  commands: [
    {
      id: 'lineage.branch-at',
      title: 'Branch from here',
      group: 'Conversations',
      when: (context) => context.entryId !== undefined,
      run: (context) => {
        if (context.conversationId !== undefined && context.entryId !== undefined)
          openStart({ from: context.conversationId, at: context.entryId })
      },
    },
    {
      id: 'lineage.branch',
      title: 'Branch…',
      group: 'Conversations',
      when: () => getConversation().id !== undefined,
      run: () => {
        const { id } = getConversation()
        if (id !== undefined) openStart({ from: id })
      },
    },
    {
      id: 'lineage.add-root',
      title: 'Make this a root',
      group: 'Conversations',
      when: () => topLevel() && shownIsTally() === false,
      run: async () => {
        const { id } = getConversation()
        if (id !== undefined) await api.action('lineage', 'root', { id })
      },
    },
  ],
})
