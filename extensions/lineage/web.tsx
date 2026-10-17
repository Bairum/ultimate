import {
  ChevronRightIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitForkIcon,
  MessagesSquareIcon,
  ScrollTextIcon,
  StickyNoteIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  cn,
  defineWebExtension,
  formatTime,
  formatTokens,
  useConversation,
  useDocOf,
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { talkToUltimate } from '../conversations/ultimate.tsx'
import { Open } from '../workspaces/landing.tsx'
import { useRoots } from './roots.tsx'
import { column, Familiarize, Survey } from './survey.tsx'

type Tally = { tokens: number; since?: number }
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
  const { branch, at, intent, images, from, side } = entry.data as {
    branch: number
    at: number
    intent: string
    images?: number
    from?: number
    side?: number
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
          className="flex min-w-0 cursor-pointer overflow-hidden text-foreground hover:underline"
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
        {side !== undefined && (
          <button
            className="shrink-0 cursor-pointer hover:text-foreground hover:underline"
            onClick={() => switchConversation(side)}
            title={`Open side chat #${side}`}
            type="button"
          >
            after side chat #{side}
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

type AbstractData = {
  conversation: number
  at: number
  text: string
  title?: string
  anchor?: number
}

/**
 * A conversation's abstract at its anchor, with the text of the newest carrier that replaced it; carriers show nothing.
 * Once a landing froze it (or, in older tallies, a later abstract superseded it), it is not shown.
 */
function Abstract({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const transcript = useTranscript()
  if ((entry.data as AbstractData).anchor !== undefined) return null
  let latest = entry
  for (const other of transcript)
    if (other.id > latest.id && other.edits?.some((edit) => edit.target === entry.id))
      latest = other
  const omitted = latest.edits?.some((edit) => edit.target === entry.id && edit.action === 'omit')
  if (omitted) return null
  const { conversation, at, text, title } = latest.data as AbstractData
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

/** A note another conversation (or the lander, a quiet `notify`, a catch-up on the tally and main) left here. */
function Note({ entry, core }: { entry: EntryRecord; core: React.ReactNode }) {
  const { from, text, source } = entry.data as {
    from?: number
    text: string
    source?: 'lander' | 'finished' | 'main' | 'side'
  }
  if (source === 'lander') return core
  if (source === 'side') return <SideNote entry={entry} />
  if (source === 'finished') return <Finished entry={entry} />
  if (source !== 'main') return <NoteCard id={from} label="Note from" note="received" text={text} />
  return (
    <section
      className="min-w-0 rounded-md border border-l-2 border-border border-l-brand/50 bg-muted/20"
      data-lineage-note="main"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-foreground">
        <GitBranchIcon className="size-3.5 text-brand" />
        Catch-up
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
  const from = /^<tally from="#(\d+)\/(\d+)">/.exec(text)
  const source = from ? Number(from[1]) : undefined
  const genesis = text.replace(/^<tally[^>]*>\n/, '').replace(/\n<\/tally>$/, '')
  return (
    <Collapsible
      className="group/genesis rounded-lg border border-brand/30 bg-brand/5"
      data-lineage-genesis={entry.conversationId}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/genesis:rotate-90" />
          Tally starts here{from ? ` · distilled from #${from[1]}/${from[2]}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">
          {source !== undefined && source !== entry.conversationId
            ? 'The project reading is distilled into the start of this tally.'
            : 'The conversation before this point is distilled into the start of the tally. Earlier messages remain available above.'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        {from && <Open id={Number(from[1])} entry={Number(from[2])} />}
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

/** A root takes no input: an empty one starts by getting familiar with the project, any other shows its tally footer. */
function RootComposer({ core, dock }: { core: ReactNode; dock?: boolean }) {
  const id = useConversation((conversation) => conversation.id)
  const roots = useRoots()
  if (id === undefined || !roots?.includes(id)) return core
  return <TallyComposer dock={dock} id={id} key={id} />
}

/** Only a root subscribes to its `lineage.tally` document; a root from before tallies has none and shows the footer. */
function TallyComposer({ id, dock }: { id: number; dock?: boolean }) {
  const tally = useDocOf<Tally>(id, tallyKind)
  const history = useConversation((conversation) =>
    conversation.loading ? undefined : conversation.entries.length > 0,
  )
  if (tally === undefined || history === undefined) return null
  if (tally?.since === undefined && !history) return <Familiarize dock={dock} id={id} />
  return <TallyFooter dock={dock} id={id} tokens={tally?.tokens} />
}

/** In place of a tally's composer: what it is, its size, and the way to @ultimate, who keeps it. */
function TallyFooter({ id, tokens, dock }: { id: number; tokens?: number; dock?: boolean }) {
  const actions = useUltimate()
  return (
    <div className={cn(column(dock), 'pb-3')}>
      <div
        className="rounded-lg border border-border bg-muted/20 px-3.5 py-2.5"
        data-lineage-tally-footer={id}
      >
        <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <ScrollTextIcon className="size-3.5 shrink-0 text-brand" />
          <span className="shrink-0 text-foreground">Tally</span>
          {tokens !== undefined && (
            <span className="shrink-0" data-lineage-tokens={tokens}>
              · {formatTokens(tokens)} tokens
            </span>
          )}
          <button
            className="ml-auto shrink-0 cursor-pointer text-brand hover:underline"
            onClick={() => void talkToUltimate(actions)}
            type="button"
          >
            Talk to @ultimate
          </button>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          The context every new branch starts from. @ultimate keeps it up to date.
        </p>
      </div>
    </div>
  )
}

/** What a side chat with a tally, from before tallies were read-only, left in it: its note, and the branch it ended in. */
function SideNote({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const transcript = useTranscript()
  const { from, text } = entry.data as { from: number; text: string }
  const started = transcript.find(
    (other) =>
      other.id > entry.id &&
      other.kind === 'lineage.branched' &&
      (other.data as { side?: number }).side === from,
  )
  const branch = (started?.data as { branch: number } | undefined)?.branch
  const open = (to: number) => (
    <button
      className="flex min-w-0 cursor-pointer text-foreground hover:underline"
      onClick={() => switchConversation(to)}
      title={`Open #${to}`}
      type="button"
    >
      <ConversationRef id={to} />
    </button>
  )
  return (
    <section
      className="min-w-0 rounded-md border border-border bg-muted/20"
      data-lineage-side-note={from}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <MessagesSquareIcon className="size-3.5 shrink-0" />
        <span className="shrink-0">Side chat ·</span>
        {open(from)}
        {branch !== undefined && (
          <>
            <span className="shrink-0">→</span>
            {open(branch)}
          </>
        )}
      </header>
      <p className="min-w-0 px-3 py-2.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
        {text}
      </p>
    </section>
  )
}

/** Keeps the roots streaming for synchronous readers, such as the `when` of the agent's Compact command. */
function Roots() {
  useRoots()
  return null
}

export default defineWebExtension({
  tools: { note: NoteCall },
  entries: {
    'lineage.branched': Branched,
    'lineage.note': Note,
    'lineage.finished': Finished,
    'lineage.abstract': Abstract,
    'lineage.survey': ({ entry }) => <Survey entry={entry} text={userText(entry)} />,
    'pi.reset': Reset,
  },
  composer: RootComposer,
  slots: { overlay: [Roots] },
})
