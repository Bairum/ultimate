import {
  ChevronRightIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitForkIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Kbd } from '@/components/ui/kbd'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  api,
  useAction,
  defineWebExtension,
  getConversation,
  getState,
  getUiState,
  useComposer,
  useDoc,
  useStore,
  useUltimate,
} from '@/sdk'
import type { EntryRecord, ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { ballSize, Crystal } from './crystal.tsx'
import { getRoots, useRoots } from './roots.tsx'
import { entryText, openStart, StartPage } from './start.tsx'

type BranchState = {
  from: number
  at: number
  intent: string
  status: 'briefing' | 'ready' | 'failed'
  error?: string
}

function userText(entry: EntryRecord) {
  const message = entry.model?.[0]
  if (message?.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

/** The source's marker of a branch started from it: a quiet divider that opens the branch. */
function Branched({ entry }: { entry: EntryRecord }) {
  const { switchConversation } = useUltimate()
  const { branch, intent } = entry.data as { branch: number; intent: string }
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
function Brief({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const { switchConversation } = useUltimate()
  const lineage = (entry.data as { lineage?: { from: number; at: number } } | undefined)?.lineage
  if (!lineage) return core
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

/** Under the composer of a branch: the brief being written, or why it failed; on the start page, its keys. */
function BriefStatus() {
  return useComposer().target === 'new' ? (
    <span className="text-muted-foreground/70 pointer-coarse:hidden">
      <Kbd>↵</Kbd> start · <Kbd>esc</Kbd> close
    </span>
  ) : (
    <BriefLookup />
  )
}

/**
 * Asks once whether the shown conversation is a branch still waiting for its brief, and only then subscribes to its
 * `lineage.branch` document: a first subscription reconnects the event stream, which every other conversation is
 * spared.
 */
function BriefLookup() {
  const { conversationId } = useUltimate()
  const info = useAction<{ roots: number[]; root?: number; branch?: BranchState }>(
    'lineage',
    'info',
    { id: conversationId ?? null },
    { enabled: conversationId !== undefined },
  )
  const status = info.data?.branch?.status
  return status && status !== 'ready' ? <BranchBrief /> : null
}

function BranchBrief() {
  const { conversationId } = useUltimate()
  const branch = useDoc<{ branch?: BranchState }>('lineage.branch')?.branch
  const [retrying, setRetrying] = useState(false)
  // While the brief is written, the overlay over the transcript says so.
  if (branch?.status !== 'failed') return null
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-error" data-lineage-status="failed">
      <TriangleAlertIcon className="size-3 shrink-0" />
      <span className="truncate" title={branch.error}>
        Brief failed: {branch.error}
      </span>
      <button
        className="shrink-0 cursor-pointer rounded px-1 text-foreground hover:bg-muted disabled:opacity-50"
        disabled={retrying}
        onClick={() => {
          setRetrying(true)
          void api
            .action('lineage', 'retry', { id: conversationId ?? null })
            .finally(() => setRetrying(false))
        }}
        type="button"
      >
        Retry
      </button>
    </span>
  )
}

/**
 * `?briefing` holds the overlay up on the conversation shown first, to polish it; a click plays the finish, then it
 * starts over.
 */
const rehearsal = new URLSearchParams(location.search).has('briefing')
let rehearsed: number | undefined

/** Branches started in this tab and not shown yet: their overlay shows at once, before `info` answers. */
const started = new Set<number>()

/** Over a branch while its brief is written: the history it inherited streaming into a crystal ball. */
function BriefingOverlay() {
  const { conversationId } = useUltimate()
  if (conversationId === undefined) return null
  if (rehearsal) {
    rehearsed ??= conversationId
    return conversationId === rehearsed ? <Rehearsal /> : null
  }
  return <BriefingOf id={conversationId} key={conversationId} />
}

/** Only while `id` is briefing: shown again later, a branch that finished meanwhile shows no overlay. */
function BriefingOf({ id }: { id: number }) {
  const [fresh] = useState(() => started.has(id))
  useEffect(() => {
    started.delete(id)
  }, [id])
  const info = useAction<{ roots: number[]; root?: number; branch?: BranchState }>(
    'lineage',
    'info',
    { id },
    { enabled: !fresh },
  )
  const branch = useDoc<{ branch?: BranchState }>('lineage.branch')?.branch
  const [gone, setGone] = useState(false)
  if (gone || (!fresh && info.data?.branch?.status !== 'briefing')) return null
  return (
    <Absorb
      from={branch?.from}
      onGone={() => setGone(true)}
      outcome={branch && branch.status !== 'briefing' ? branch.status : undefined}
    />
  )
}

function Rehearsal() {
  const [take, setTake] = useState(0)
  const [outcome, setOutcome] = useState<'ready'>()
  return (
    <Absorb
      from={1}
      key={take}
      onClick={() => setOutcome('ready')}
      onGone={() => {
        setOutcome(undefined)
        setTake((current) => current + 1)
      }}
      outcome={outcome}
    />
  )
}

/** The overlay stays at least this long before the ball flows down, so a quick brief does not flash. */
const minimum = 1500
/** Where the ball flows to, in pixels above the bottom: into the composer. */
const composer = 72

/**
 * The overlay over the whole conversation, which is inert beneath it: the transcript dimmed behind the ball while dust
 * streams into it. Once the brief is ready the dimming lifts and the ball flows down into the composer, which then takes
 * focus; a failed brief fades at once, the composer saying why.
 */
function Absorb({
  from,
  outcome,
  onGone,
  onClick,
}: {
  from?: number
  outcome?: 'ready' | 'failed'
  onGone: () => void
  onClick?: () => void
}) {
  const theme = useStore((state) => state.ui.theme)
  const { focusComposer } = useUltimate()
  const root = useRef<HTMLDivElement>(null)
  const dim = useRef<HTMLDivElement>(null)
  const ball = useRef<HTMLDivElement>(null)
  const glow = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLParagraphElement>(null)
  const finish = useRef({ onGone, focusComposer })
  finish.current = { onGone, focusComposer }
  const [still] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [shown] = useState(() => performance.now())
  const [ended, setEnded] = useState<'ready' | 'failed'>()
  const [landed, setLanded] = useState(false)
  useEffect(() => {
    if (!outcome) return undefined
    const left = outcome === 'ready' && !still ? minimum - (performance.now() - shown) : 0
    const timer = setTimeout(() => setEnded(outcome), Math.max(0, left))
    return () => clearTimeout(timer)
  }, [outcome, still, shown])
  useLayoutEffect(() => {
    const overlay = root.current!
    // The conversation beneath takes no input, the composer included.
    const beneath = [...overlay.parentElement!.children].filter(
      (element): element is HTMLElement => element !== overlay && element instanceof HTMLElement,
    )
    for (const element of beneath) element.inert = true
    // Each layer fades on its own: fading the overlay itself would leave the dimming nothing to blur.
    const appear = [dim.current!, label.current!].map((layer) =>
      layer.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: still ? 0 : 350,
        easing: 'ease-out',
        fill: 'both',
      }),
    )
    return () => {
      for (const animation of appear) animation.cancel()
      for (const element of beneath) element.inert = false
    }
  }, [still])
  // Ready: the ball condenses and drops, and on landing a glow spreads along the composer and the dimming lifts.
  // Failed, or with reduced motion: it all fades at once.
  const finished = ended === 'failed' || (ended === 'ready' && still) || landed
  useEffect(() => {
    if (!finished) return undefined
    const out = [{ opacity: 1 }, { opacity: 0 }]
    const animations =
      landed && !still
        ? [
            glow.current!.animate(
              [
                { opacity: 0, transform: 'translateX(-50%) scaleX(0.15)' },
                { opacity: 1, transform: 'translateX(-50%) scaleX(1)', offset: 0.35 },
                { opacity: 0, transform: 'translateX(-50%) scaleX(1.05)' },
              ],
              { duration: 900, easing: 'ease-out', fill: 'both' },
            ),
            dim.current!.animate(out, { duration: 450, easing: 'ease-in-out', fill: 'both' }),
            ball.current!.animate(out, { delay: 300, duration: 600, fill: 'both' }),
          ]
        : [dim.current!, ball.current!, label.current!].map((layer) =>
            layer.animate(out, { duration: still ? 150 : 300, fill: 'both' }),
          )
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        finish.current.onGone()
        finish.current.focusComposer()
      },
      // Cancelled as the overlay unmounts or a rehearsal starts over.
      () => {},
    )
    return () => {
      for (const animation of animations) animation.cancel()
    }
  }, [finished, landed, still])
  useEffect(() => {
    if (ended !== 'ready' || still) return undefined
    const fade = label.current!.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 200,
      fill: 'both',
    })
    return () => fade.cancel()
  }, [ended, still])
  return (
    <div
      aria-live="polite"
      className="pointer-events-auto absolute inset-0 z-10 [container-type:size]"
      data-lineage-status="briefing"
      onClick={onClick}
      ref={root}
      role="status"
    >
      <div className="absolute inset-0 bg-background/85 backdrop-blur-[3px]" ref={dim} />
      <div
        className="absolute left-1/2 h-24 w-[min(100%,48rem)] translate-y-1/2 bg-[radial-gradient(ellipse_at_center,color-mix(in_oklab,var(--brand)_45%,transparent),transparent_70%)] opacity-0"
        ref={glow}
        style={{ bottom: composer }}
      />
      <div className="absolute inset-0" ref={ball}>
        <Crystal
          className="size-full"
          color={theme === 'dark' ? '#bb9af4' : '#7b47bf'}
          done={ended === 'ready'}
          drop={composer}
          onLand={() => setLanded(true)}
          theme={theme}
        />
      </div>
      <p
        className="absolute inset-x-0 text-center font-mono text-[12px] text-muted-foreground"
        ref={label}
        style={{
          top: `calc(${ballSize.top * 100}% + clamp(${ballSize.min}px, ${ballSize.fraction * 100}cqmin, ${ballSize.max}px) + 28px)`,
        }}
      >
        Writing the brief
        {from !== undefined && (
          <>
            {' '}
            from <ConversationRef id={from} />
          </>
        )}
        …
      </p>
    </div>
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
    const isolated =
      draft.isolated ??
      (getUiState('ext.conversations.creationType') !== 'shared' &&
        getState().system?.extensions.some((extension) => extension.name === 'workspaces') === true)
    if (root) {
      const { from: _from, at: _at, ...input } = draft
      return api.action<{ id: number }>('lineage', 'newRoot', { ...input, isolated })
    }
    const from = draft.from ?? (await defaultRoot())
    if (from === undefined) throw new Error('There is no root to branch from')
    const branch = await api.action<{ id: number }>('lineage', 'branch', {
      ...draft,
      from,
      isolated,
    })
    started.add(branch.id)
    return branch
  },
  tools: { note: NoteCall },
  entries: {
    'lineage.branched': Branched,
    'lineage.note': Note,
    'lineage.finished': Finished,
    'pi.reset': Brief,
  },
  slots: {
    'composer.status': [BriefStatus],
    'conversation.overlay': [BriefingOverlay, StartPage],
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
      when: () => topLevel() && getRoots()?.includes(getConversation().id!) === false,
      run: async () => {
        const { id } = getConversation()
        if (id !== undefined) await api.action('lineage', 'root', { id })
      },
    },
  ],
})
