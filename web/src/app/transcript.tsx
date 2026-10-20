import type {
  AssistantMessage,
  ImageContent,
  SystemMessage,
  TextContent,
  ToolCall,
  UserMessage,
} from '@earendil-works/pi-ai'
import type { EntryRecord, LiveState, ToolSlot } from '@earendil-works/pi-durable'
import { cn } from 'cn'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleStopIcon,
  CopyIcon,
  LinkIcon,
  RotateCwIcon,
} from 'lucide-react'
import {
  Fragment,
  memo,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import type { StickToBottomContext } from 'use-stick-to-bottom'
import { useEvent } from '../sdk/events.ts'
import { api } from '../sdk/client.ts'
import { Button } from '@/components/ui/button'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai/conversation'
import { MentionText, Message, MessageContent, MessageResponse } from '@/components/ai/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai/reasoning'
import { Shimmer } from '@/components/ai/shimmer'
import { ToolImage, ToolStatusIcon } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { elidePath, formatDuration, formatTime, shortenPath } from '../sdk/format.ts'
import {
  TranscriptContext,
  useChat,
  useConversation,
  useExtensions,
  useIntro,
  useModels,
  useNow,
  useStore,
  useSystem,
} from '../sdk/hooks.ts'
import { entryRenderers, messageItems, toolLine } from '../sdk/registry.ts'
import { covered } from '../sdk/resume.ts'
import { ExtensionBoundary } from './boundary.tsx'
import { chatRows, runOf, windowGaps, windowKey } from './chat.ts'
import { useFold } from './fold.tsx'
import type { ChatPart, WorkRun } from './chat.ts'
import { column } from './layout.ts'
import { indexTools, partialOf, slotsOf, toolCallView } from './model.ts'
import type { ToolResult } from './model.ts'
import { ToolCallBlock } from './tool-call.tsx'
import { TranscriptSkeleton } from './transcript-skeleton.tsx'

/** The shown conversation; `dock` fits it into a narrow side region. */
export function Transcript({ dock }: { dock?: boolean }) {
  const { id, loading, busy } = useConversation()
  // A conversation without messages opens as it is: no placeholder, nothing rising in.
  const messages = useStore((state) => {
    const shown = state.conversations.find(
      (conversation) => conversation.id === (state.requested ?? id),
    )
    return shown?.inputAt !== undefined || shown?.answerAt !== undefined
  })
  const stick = useRef<StickToBottomContext>(null)
  const skeleton = useRef<HTMLDivElement>(null)
  // The placeholder outlives loading by its fade-out, which crosses over with the rows coming in.
  const [placeholder, setPlaceholder] = useState(loading && messages)
  if (loading && messages && !placeholder) setPlaceholder(true)
  useLayoutEffect(() => {
    if (loading || !placeholder) return undefined
    if (!skeleton.current || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPlaceholder(false)
      return undefined
    }
    const fade = skeleton.current.animate([{ opacity: 0 }], {
      duration: 300,
      easing: 'ease-out',
      fill: 'forwards',
    })
    fade.finished.then(
      () => setPlaceholder(false),
      () => {
        // Cancelled: another conversation started loading, and the placeholder stays for it.
      },
    )
    return () => fade.cancel()
  }, [loading, placeholder])
  // Rows on screen come into focus from the bottom up, unless there are none or a resumed reload already shows them.
  // Opacity and blur only: a moving row would suspend the browser's scroll anchoring while older rows render above.
  const reveal = useEffectEvent((scroll: HTMLElement, content: HTMLElement) => {
    if (!messages || covered() || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // Rows settle shorter as they finish rendering, pulling rows from above into view: animate a screen of those too.
    const view = scroll.getBoundingClientRect()
    const rows = [...content.children].filter((row) => {
      const box = row.getBoundingClientRect()
      return box.height > 0 && box.bottom > view.top - view.height && box.top < view.bottom
    })
    rows.toReversed().forEach((row, index) =>
      row.animate(
        [
          { opacity: 0, filter: 'blur(4px)' },
          { opacity: 1, filter: 'none' },
        ],
        {
          delay: index * 30,
          duration: 450,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'backwards',
        },
      ),
    )
  })
  // Paint a newly shown conversation at its newest row; sticking to the bottom only scrolls a frame later.
  useLayoutEffect(() => {
    const scroll = stick.current?.scrollRef.current
    const content = stick.current?.contentRef.current
    if (!scroll || !content) return undefined
    scroll.scrollTop = scroll.scrollHeight
    if (id !== undefined) reveal(scroll, content)
    // The library observes content growth, not viewport shrinkage as the composer grows.
    // Reuse its follow lock so resizing never pulls someone away from older messages.
    const resize = new ResizeObserver(() => {
      void stick.current?.scrollToBottom({ animation: 'instant', preserveScrollPosition: true })
    })
    resize.observe(scroll)
    return () => resize.disconnect()
  }, [id])
  // A sent message pins the view to the bottom and follows the run, even when the reader had scrolled up.
  useEvent('ultimate:sent', (value) => {
    if ((value as { conversationId?: number } | undefined)?.conversationId === id)
      void stick.current?.scrollToBottom({ animation: 'instant' })
  })
  // Keyed so a conversation never inherits the previous one's scroll position or follow state.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Follow a streaming reply smoothly; otherwise late growth, such as an image decoding, just stays at the bottom. */}
      <Conversation
        className="min-h-0"
        contextRef={stick}
        key={id}
        resize={busy ? 'smooth' : 'instant'}
      >
        <ConversationContent className={cn(column(dock), 'gap-3 pt-6 pb-10')}>
          <TranscriptEntries />
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {placeholder && <TranscriptSkeleton dock={dock} ref={skeleton} />}
    </div>
  )
}

function TranscriptEntries() {
  const { id, entries: active, older, live, busy, loading } = useConversation()
  const [history, setHistory] = useState<EntryRecord[]>([])
  const previousActive = useRef(active)
  const previousWindow = useRef('')
  const [tailSpace, setTailSpace] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [exhausted, setExhausted] = useState(false)
  const [before, setBefore] = useState<number>()
  // A windowed stream pages on from its oldest entry. A whole one after a head marker scans from its newest: retained
  // suffixes can precede discarded compaction markers, which a minimum-active-ID cursor would skip. A whole one without
  // a marker is the whole history.
  const cursor = exhausted
    ? undefined
    : (before ?? older ?? (active[0]?.head === undefined ? undefined : active.at(-1)?.id))
  const request = useRef<AbortController | null>(null)
  const anchor = useRef<{
    entryId: number
    /** The last entry of a folded run: its row keeps that id when a page brings earlier entries into the run. */
    last?: number
    /** A row inside an opened run. */
    inner?: boolean
    toolCallId?: string
    top: number
  } | null>(null)
  // Ranges of stored history a fresh window does not cover: discarded markers after a head marker, and what arrived
  // while a reconnect was away. Filled once per range, by its `after:before` key; failed ones wait for Retry.
  const filled = useRef(new Set<string>())
  const failed = useRef<[number, number][]>([])
  const [filling, setFilling] = useState(0)
  const sentinel = useRef<HTMLDivElement>(null)
  const { contentRef, scrollRef, stopScroll, state, isAtBottom, escapedFromLock } =
    useStickToBottomContext()
  // While following, the browser must not anchor: a row above that shrinks as the last one grows would move the view up,
  // and the library reads that scroll as the reader leaving. A reader who scrolled up keeps anchoring, so rows changing
  // above them stay put. A passive effect: the scroller, an ancestor, attaches its ref after these rows' layout effects.
  const following = isAtBottom && !escapedFromLock
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.style.overflowAnchor = following ? 'none' : ''
  }, [following, scrollRef])
  // Retain already displayed rows when a live compaction replaces the active context, or a fresh window moves past them.
  const entries = useMemo(() => {
    const rows = new Map(history.map((entry) => [entry.id, entry]))
    for (const entry of previousActive.current) rows.set(entry.id, entry)
    for (const entry of active) rows.set(entry.id, entry)
    return [...rows.values()].toSorted((a, b) => a.id - b.id)
  }, [history, active])
  /** Read every stored entry from `after` up to `upTo`, once per range, into the loaded history. */
  const fill = useEffectEvent((after: number, upTo: number) => {
    const key = `${after}:${upTo}`
    if (id === undefined || after >= upTo || filled.current.has(key)) return
    filled.current.add(key)
    setFilling((count) => count + 1)
    void (async () => {
      try {
        const rows: EntryRecord[] = []
        for (let next: number | undefined = upTo; next !== undefined;) {
          const page = await api.history(id, next, undefined, after)
          rows.push(...page.entries)
          next = page.before
        }
        setHistory((previous) => {
          const merged = new Map(previous.map((entry) => [entry.id, entry]))
          for (const entry of rows) merged.set(entry.id, entry)
          return [...merged.values()]
        })
      } catch (failure) {
        filled.current.delete(key)
        failed.current.push([after, upTo])
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setFilling((count) => count - 1)
      }
    })()
  })
  // Retry clears the error; failed fills then run again, and the sentinel pages on.
  const retry = () => setError('')
  useEffect(() => {
    if (!error) for (const [after, upTo] of failed.current.splice(0)) fill(after, upTo)
  }, [error])
  const loadedBelow = useEffectEvent((dropped: readonly EntryRecord[]) => [...history, ...dropped])
  useLayoutEffect(() => {
    const current = new Set(active.map((entry) => entry.id))
    const dropped = previousActive.current.filter((entry) => !current.has(entry.id))
    if (
      active.some(
        (entry) =>
          (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') &&
          !previousActive.current.some((old) => old.id === entry.id),
      )
    ) {
      request.current?.abort()
      request.current = null
      anchor.current = null
      setPending(false)
      setError('')
      setBefore(older ?? Math.max(...active.map((entry) => entry.id)))
      setExhausted(false)
    }
    if (dropped.length)
      setHistory((previous) => {
        const rows = new Map(previous.map((entry) => [entry.id, entry]))
        for (const entry of dropped) rows.set(entry.id, entry)
        return [...rows.values()]
      })
    // A fresh window (a new `older`; appends keep it) can leave stored history uncovered.
    const window = windowKey(active, older)
    const fresh = window !== previousWindow.current
    previousWindow.current = window
    if (older !== undefined && fresh && active.length)
      for (const [after, upTo] of windowGaps(active, older, loadedBelow(dropped))) fill(after, upTo)
    previousActive.current = active
  }, [active, older])
  useEffect(() => () => request.current?.abort(), [])
  useLayoutEffect(() => {
    if (anchor.current && scrollRef.current) {
      const { entryId, last, inner, toolCallId: callId, top } = anchor.current
      // A folded run's row is found by its last entry: a page that reaches into the run gives it an earlier first one.
      // A row inside an opened run is found below its run's row, which can carry the same id.
      const entry =
        last !== undefined
          ? contentRef.current?.querySelector(`:scope > [data-run-last="${last}"]`)
          : inner
            ? contentRef.current?.querySelector(`[data-run-last] [data-entry-id="${entryId}"]`)
            : contentRef.current?.querySelector(`[data-entry-id="${entryId}"]`)
      const tool =
        callId === undefined
          ? undefined
          : entry?.querySelector(`[data-tool-call-id="${CSS.escape(callId)}"]`)
      const element = tool && tool.getBoundingClientRect().height > 0 ? tool : entry
      if (element) scrollRef.current.scrollTop += element.getBoundingClientRect().top - top
      anchor.current = null
    }
  }, [history, scrollRef, contentRef])
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || tailSpace === 0) return undefined
    const releaseTail = () => {
      // Release temporary space once it cannot clamp the reader, or they return to the bottom.
      const gap = contentRef.current
        ? Number.parseFloat(getComputedStyle(contentRef.current).rowGap) || 0
        : 0
      const bottom = scroll.scrollHeight - scroll.clientHeight
      if (scroll.scrollTop <= bottom - tailSpace - gap || scroll.scrollTop >= bottom - 1)
        setTailSpace(0)
    }
    scroll.addEventListener('scroll', releaseTail)
    releaseTail()
    return () => scroll.removeEventListener('scroll', releaseTail)
  }, [tailSpace, active, scrollRef, contentRef])
  const loadEarlier = useEffectEvent(async () => {
    if (id === undefined || request.current || cursor === undefined) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    try {
      const page = await api.history(id, cursor, controller.signal)
      if (controller.signal.aborted) return
      const { calls: mergedCalls } = indexTools([...entries, ...page.entries])
      // Rows older than the page, such as a head marker shown first, stay above it: anchor a row the page goes above.
      const newest = Math.max(0, ...page.entries.map((entry) => entry.id))
      const survivors = new Set<number>(
        entries
          .filter(
            (entry) =>
              entry.id > newest &&
              !(entry.kind === 'pi.tool-result' && mergedCalls.has(toolCallId(entry) ?? '')),
          )
          .map((entry) => entry.id),
      )
      // Rows the reader sees: top-level rows, and the rows inside an opened run instead of the run itself, whose top stays
      // put while a page reaches into it and grows it above them; an inner anchor is found inside its run only.
      const shown = (contentRef.current?.querySelectorAll(':scope > [data-entry-id]') ??
        []) as Iterable<Element>
      const candidates = [...shown]
        .flatMap((row) => {
          const inside = [...row.querySelectorAll('[data-entry-id]')]
          return inside.length ? inside : [row]
        })
        .filter(
          (row) =>
            row.getBoundingClientRect().bottom >
            (scrollRef.current?.getBoundingClientRect().top ?? 0),
        )
      // A result row disappears when this page brings its assistant call. Anchor a surviving
      // row, or its matching replacement tool when no existing displayed row survives.
      const element = candidates.find((row) =>
        survivors.has(Number(row.getAttribute('data-entry-id'))),
      )
      if (element) {
        anchor.current = {
          entryId: Number(element.getAttribute('data-entry-id')),
          last: Number(element.getAttribute('data-run-last')) || undefined,
          inner: !element.parentElement?.isSameNode(contentRef.current),
          top: element.getBoundingClientRect().top,
        }
      } else if (candidates[0]) {
        const orphan = entries.find(
          (entry) => entry.id === Number(candidates[0].getAttribute('data-entry-id')),
        )
        const callId = orphan && toolCallId(orphan)
        const replacement = page.entries.find((entry) => {
          const message = entry.model?.[0]
          return (
            entry.kind === 'pi.assistant' &&
            message?.role === 'assistant' &&
            message.content.some((block) => block.type === 'toolCall' && block.id === callId)
          )
        })
        if (replacement)
          anchor.current = {
            entryId: replacement.id,
            toolCallId: callId,
            top: candidates[0].getBoundingClientRect().top,
          }
      }
      // The anchor holds the rows in place; a reader who left the bottom stops following. The lock, not the distance:
      // while a run streams, the follow animation is still catching up and the distance is briefly larger.
      if (!state.isAtBottom) stopScroll()
      // A short transcript needs its existing empty tail to remain scrollable after prepending.
      setTailSpace((space) =>
        Math.max(
          space,
          (scrollRef.current?.clientHeight ?? 0) - (contentRef.current?.clientHeight ?? 0),
        ),
      )
      setHistory((previous) => {
        const rows = new Map(previous.map((entry) => [entry.id, entry]))
        for (const entry of page.entries) rows.set(entry.id, entry)
        return [...rows.values()]
      })
      setBefore(page.before)
      setExhausted(page.before === undefined)
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (!controller.signal.aborted) {
        request.current = null
        setPending(false)
      }
    }
  })
  // Page in earlier history while the top comes within a viewport. A new observer after each page reports at once
  // whether the top is still that close.
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !sentinel.current || loading || pending || error || cursor === undefined)
      return undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void loadEarlier()
      },
      { root, rootMargin: '100% 0px 0px 0px' },
    )
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [scrollRef, loading, pending, error, cursor, history])
  /** Read stored history down to entry `target`, in large pages bounded by it, so a reveal can scroll there. */
  const loadDown = async (target: number) => {
    if (id === undefined || request.current || cursor === undefined) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    try {
      const rows: EntryRecord[] = []
      for (let next: number | undefined = cursor; next !== undefined;) {
        const page = await api.history(id, next, controller.signal, target)
        rows.push(...page.entries)
        next = page.before
      }
      if (controller.signal.aborted) return
      stopScroll()
      setHistory((previous) => {
        const merged = new Map(previous.map((entry) => [entry.id, entry]))
        for (const entry of rows) merged.set(entry.id, entry)
        return [...merged.values()]
      })
      setBefore(target)
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (!controller.signal.aborted) {
        request.current = null
        setPending(false)
      }
    }
  }
  const { results, calls } = useMemo(() => indexTools(entries), [entries])
  // Keyed on the tools, not `live`: a streamed token must not re-render every row.
  const slots = useMemo(() => slotsOf(live.tools), [live.tools])
  const partial = partialOf(live)
  const visible = entries.filter(
    (entry) => !(entry.kind === 'pi.tool-result' && calls.has(toolCallId(entry) ?? '')),
  )
  const chat = useChat()
  const keeps = (call: ToolCall) => !!chat?.(call)
  const rows: (ChatPart | WorkRun)[] = chat
    ? chatRows(visible, keeps)
    : visible.map((entry) => ({ entry }))
  // Folded runs the reader or a reveal opened, by the keys of all their parts: a run that gains earlier entries from a
  // page, or later ones live, stays open.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const isOpen = (run: WorkRun) => run.work.some((part) => opened.has(partKey(part)))
  const open = (run: WorkRun, value: boolean) =>
    setOpened((keys) => {
      const next = new Set(keys)
      for (const part of run.work) {
        if (value) next.add(partKey(part))
        else next.delete(partKey(part))
      }
      return next
    })
  // Reveal a stored row without the auto-follow animation overriding the jump; a row older than those loaded needs the
  // history down to it first, and one in a folded run needs the run open.
  const [reveal, setReveal] = useState<number>()
  useEvent('ultimate:reveal-entry', (value) => {
    const target = value as { conversationId?: number; entryId?: number } | undefined
    const entryId = target?.entryId
    if (target?.conversationId === id && entryId !== undefined && Number.isSafeInteger(entryId))
      setReveal(entryId)
  })
  const revealStep = useEffectEvent(() => {
    if (reveal === undefined || loading || pending) return
    if (error) {
      setReveal(undefined)
      return
    }
    if (!entries.some((entry) => entry.id === reveal)) {
      if (cursor !== undefined && reveal < cursor) {
        void loadDown(reveal)
        return
      }
      // Inside the window's range: a fill still reading it brings it.
      if (filling) return
    }
    // Open its folded run first; the next commit scrolls.
    const run = chat && runOf(rows, reveal)
    if (run && !isOpen(run)) {
      open(run, true)
      return
    }
    const element = contentRef.current?.querySelector(`[data-entry-id="${reveal}"]`)
    if (element) {
      stopScroll()
      element.scrollIntoView({ block: 'start' })
    }
    setReveal(undefined)
  })
  useLayoutEffect(() => revealStep(), [reveal, loading, pending, error, history, opened, filling])
  return (
    <TranscriptContext value={entries}>
      {!loading && entries.length > 0 && cursor !== undefined && (
        <div
          className="flex min-h-5 items-center justify-center font-mono text-[11px] text-muted-foreground/70"
          ref={sentinel}
        >
          {pending ? (
            <Shimmer>loading earlier messages…</Shimmer>
          ) : (
            error && (
              <span className="flex items-center gap-2" role="alert">
                <span className="text-error">Could not load earlier messages</span>
                <Button
                  className="h-6 cursor-pointer px-2 font-mono text-[11px]"
                  onClick={retry}
                  size="sm"
                  variant="ghost"
                >
                  Retry
                </Button>
              </span>
            )
          )}
        </div>
      )}
      {!loading && visible.length === 0 && !partial && <EmptyState />}
      {rows.map((row, index) =>
        'work' in row ? (
          <div
            className="empty:hidden"
            data-conversation-id={id}
            data-entry-id={row.work[0].entry.id}
            data-run-last={row.work.at(-1)!.entry.id}
            key={partKey(row.work[0])}
          >
            <WorkRow
              busy={busy}
              onOpenChange={(value) => open(row, value)}
              open={isOpen(row)}
              results={results}
              run={row}
              slots={slots}
              working={busy && index === rows.length - 1}
            />
          </div>
        ) : (
          <div
            className="empty:hidden"
            data-conversation-id={id}
            data-entry-id={row.entry.id}
            key={partKey(row)}
          >
            <EntryView
              blocks={row.blocks}
              busy={busy}
              entry={row.entry}
              results={results}
              slots={slots}
            />
          </div>
        ),
      )}
      {partial && (
        <AssistantView busy message={partial} results={results} slots={slots} streaming />
      )}
      <LiveStatus busy={busy} live={live} partial={partial} />
      {tailSpace > 0 && (
        <div aria-hidden="true" data-history-anchor-space style={{ height: tailSpace }} />
      )}
    </TranscriptContext>
  )
}

const partKey = (part: ChatPart) =>
  part.blocks ? `${part.entry.id}:${part.blocks[0]}` : String(part.entry.id)

/** A run of work in a chat as one quiet row that expands to the usual rendering. */
function WorkRow({
  run,
  working,
  open,
  onOpenChange,
  results,
  slots,
  busy,
}: {
  run: WorkRun
  working: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  return (
    <Collapsible className="group/work" onOpenChange={onOpenChange} open={open}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground">
        {working ? 'working' : 'worked'} · {run.steps} step{run.steps === 1 ? '' : 's'}
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/work:rotate-90" />
      </CollapsibleTrigger>
      {!open && (
        <StepLines
          busy={busy}
          onOpen={() => onOpenChange(true)}
          results={results}
          run={run}
          slots={slots}
        />
      )}
      <CollapsibleContent className="mt-3 flex flex-col gap-3 border-l border-border/70 pl-3">
        {run.work.map((part) => (
          <div className="empty:hidden" data-entry-id={part.entry.id} key={partKey(part)}>
            <EntryView
              blocks={part.blocks}
              busy={busy}
              entry={part.entry}
              results={results}
              slots={slots}
            />
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The tool calls of a folded run, in order. */
function runCalls(run: WorkRun): ToolCall[] {
  return run.work.flatMap(({ entry, blocks }) => {
    const message = entry.model?.[0]
    if (message?.role !== 'assistant') return []
    return message.content.flatMap((block, index) =>
      block.type === 'toolCall' && (!blocks || blocks.includes(index)) ? [block] : [],
    )
  })
}

/** Lines a folded run lists before “+N earlier”: the newest ones. */
const STEP_LINES = 8

/** A folded run's tool calls as a quiet list of one-line steps, newest last; clicking it opens the run. */
function StepLines({
  run,
  results,
  slots,
  busy,
  onOpen,
}: {
  run: WorkRun
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  onOpen: () => void
}) {
  const extensions = useExtensions()
  const calls = runCalls(run)
  if (calls.length === 0) return null
  const shown = calls.slice(-STEP_LINES)
  return (
    <button
      className="mt-1.5 flex w-full min-w-0 cursor-pointer flex-col gap-0.5 border-l border-border/70 pl-3 text-left font-mono text-[11.5px] leading-[1.6] text-muted-foreground hover:text-foreground/90"
      onClick={onOpen}
      type="button"
    >
      {calls.length > shown.length && (
        <span className="text-muted-foreground/60">+{calls.length - shown.length} earlier</span>
      )}
      {shown.map((block) => {
        const call = toolCallView(block, {
          result: results.get(block.id),
          slot: slots.get(block.id),
          streaming: false,
          busy,
        })
        const line = toolLine(extensions, call.name)
        return (
          <span className="flex min-w-0 items-center gap-2" key={block.id}>
            <ToolStatusIcon className="size-3" state={call.status} />
            <span className="min-w-0 flex-1 truncate">
              {line ? (
                <ExtensionBoundary
                  extension={line.extension}
                  fallback={call.name}
                  variant="inline"
                  version={line.version}
                >
                  <line.component call={call} />
                </ExtensionBoundary>
              ) : (
                call.name
              )}
            </span>
          </span>
        )
      })}
    </button>
  )
}

/** What this Ultimate is and runs on, before the first message. */
function EmptyState() {
  const system = useSystem()
  const intro = useIntro()
  const { agent } = useConversation()
  const reasoning = useModels()?.models.find(
    (model) => model.provider === agent.model?.provider && model.id === agent.model.modelId,
  )?.reasoning
  const cwd = agent.cwd ?? system?.execution.defaultCwd ?? ''
  const rows: [string, ReactNode][] = [
    [
      'repo',
      <>
        {elidePath(shortenPath(cwd, { home: system?.machine.home }), 44)}
        {system?.code.branch && cwd === system.code.ultimateRoot && (
          <span className="text-muted-foreground"> ({system.code.branch})</span>
        )}
      </>,
    ],
    [
      'model',
      agent.model ? (
        `${agent.model.provider}/${agent.model.modelId}${reasoning !== false && agent.thinkingLevel ? ` · ${agent.thinkingLevel}` : ''}`
      ) : (
        // oxlint-disable-next-line react/jsx-key -- a [label, value] row, not a rendered list
        <span className="text-warning">none configured</span>
      ),
    ],
    [
      'ext',
      system?.extensions
        .filter((extension) => extension.enabled)
        .map((extension) => extension.name)
        .join(' · ') ?? '…',
    ],
    [
      'host',
      system
        ? `${system.machine.hostname} · ${system.process.node} · gen ${system.process.generation}`
        : '…',
    ],
  ]
  const Card = intro?.card
  return (
    <ConversationEmptyState className="min-h-[55vh]">
      <div className="w-full max-w-md font-mono text-[12px]">
        <div className="text-[13px] font-semibold tracking-[0.3em] text-brand">ULTIMATE</div>
        <div className="mt-1 font-sans text-[13px] text-muted-foreground">
          {intro?.title ??
            (!system || system.project.root === system.code.ultimateRoot
              ? 'A coding agent that edits this repository, itself included.'
              : `A coding agent that edits ${system.project.name}, and can change itself too.`)}
        </div>
        {intro?.hint && (
          <div className="mt-1 font-sans text-[12.5px] text-muted-foreground/70">{intro.hint}</div>
        )}
        <div className="mt-5 grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 border-t border-border/70 pt-4 text-left">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <span className="text-muted-foreground/70">{label}</span>
              <span className="truncate text-foreground/85">{value}</span>
            </Fragment>
          ))}
        </div>
        {Card && intro && (
          <div className="mt-5 text-left">
            <ExtensionBoundary extension={intro.extension} version={intro.version}>
              <Card />
            </ExtensionBoundary>
          </div>
        )}
      </div>
    </ConversationEmptyState>
  )
}

function toolCallId(entry: EntryRecord) {
  const message = entry.model?.[0]
  return message?.role === 'toolResult' ? message.toolCallId : undefined
}

function textOf(content: string | readonly (TextContent | ImageContent)[]) {
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

interface RowProps {
  entry: EntryRecord
  /** The content blocks of an assistant message shown in this row; all when absent. */
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}

const EntryView = memo(function EntryView({ entry, blocks, results, slots, busy }: RowProps) {
  // Renderers compose in discovery order: each receives the one before it as `core`, and falls back to it.
  return entryRenderers(useExtensions(), entry.kind).reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary extension={extension} fallback={inner} key={extension} version={version}>
        <Renderer blocks={blocks} core={inner} entry={entry} />
      </ExtensionBoundary>
    ),
    coreEntry(entry, results, slots, busy, blocks),
  )
}, sameRow)

/** The tool calls a row shows: an assistant's calls, or the call of a result shown on its own. */
function rowCalls(entry: EntryRecord): string[] {
  const message = entry.model?.[0]
  if (message?.role === 'toolResult') return [message.toolCallId]
  if (message?.role !== 'assistant') return []
  return message.content.flatMap((block) => (block.type === 'toolCall' ? [block.id] : []))
}

/** A row changes only with its entry and its own calls, so a new entry or run re-renders just the rows it touches. */
function sameRow(a: RowProps, b: RowProps) {
  if (a.entry !== b.entry || a.blocks?.join() !== b.blocks?.join()) return false
  return rowCalls(b.entry).every((id) => {
    const result = b.results.get(id)?.message
    return (
      a.results.get(id)?.message === result &&
      a.slots.get(id) === b.slots.get(id) &&
      (result !== undefined || a.busy === b.busy)
    )
  })
}

function coreEntry(
  entry: EntryRecord,
  results: Map<string, ToolResult>,
  slots: Map<string, ToolSlot>,
  busy: boolean,
  blocks?: readonly number[],
): ReactNode {
  const message = entry.model?.[0]
  switch (entry.kind) {
    case 'pi.user':
      return message?.role === 'user' ? <UserView entry={entry} message={message} /> : null
    case 'pi.assistant':
      return message?.role === 'assistant' ? (
        <AssistantView
          blocks={blocks}
          busy={busy}
          entry={entry}
          message={message}
          results={results}
          slots={slots}
        />
      ) : null
    case 'pi.system':
      return message?.role === 'system' ? (
        <SystemDivider entry={entry.id} message={message} />
      ) : null
    case 'pi.compaction':
      return <CompactionView entry={entry} />
    case 'pi.reset':
      return <Divider>context reset{message?.role === 'user' ? ' · handoff' : ''}</Divider>
    case 'pi.tool-result': {
      if (message?.role !== 'toolResult') return null
      const call: ToolCall = {
        type: 'toolCall',
        id: message.toolCallId,
        name: message.toolName,
        arguments: {},
      }
      return (
        <ToolCallBlock
          call={toolCallView(call, { result: results.get(call.id), streaming: false, busy })}
        />
      )
    }
    default:
      return <UnknownEntry entry={entry} />
  }
}

/** Hover actions on a stored message, always shown on touch screens: extensions' details, its time, and copies of its text or of a reference another conversation can follow. */
function MessageActions({
  entry,
  text,
  timestamp,
  className,
}: {
  entry: EntryRecord
  text: string
  timestamp: number
  className?: string
}) {
  const extensions = useExtensions()
  const details = messageItems(extensions, 'messageDetails')
  const contributions = messageItems(extensions, 'messageActions')
  const { conversationId: conversation, id } = entry
  const reference = `Ultimate conversation #${conversation}, message #${id}. Read it in codemode with ultimate.entries(${conversation}, { before: ${id + 1}, limit: 1 }).`
  const date = new Date(timestamp)
  return (
    <div
      className={cn(
        'flex items-center gap-2 font-mono text-[11px] text-muted-foreground/60 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
        className,
      )}
    >
      {details.map(({ key, extension, version, component: Detail }) => (
        <ExtensionBoundary extension={extension} fallback={null} key={key} version={version}>
          <Detail entry={entry} />
        </ExtensionBoundary>
      ))}
      <time className="tabular-nums" dateTime={date.toISOString()} title={date.toLocaleString()}>
        {formatTime(date)}
      </time>
      {text && (
        <CopyButton label="Copy message" value={text}>
          <CopyIcon />
        </CopyButton>
      )}
      {contributions.map(({ key, extension, version, component: Action }) => (
        <ExtensionBoundary extension={extension} fallback={null} key={key} version={version}>
          <Action entry={entry} />
        </ExtensionBoundary>
      ))}
      <CopyButton label={`Copy reference to message #${id}`} value={reference}>
        <LinkIcon />
      </CopyButton>
    </div>
  )
}

function CopyButton({
  value,
  label,
  children,
}: {
  value: string
  label: string
  children: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      aria-label={label}
      className="cursor-pointer rounded p-0.5 transition-colors hover:text-foreground [&_svg]:size-3"
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1200)
        })
      }
      title={label}
      type="button"
    >
      {copied ? <CheckIcon className="text-success" /> : children}
    </button>
  )
}

function UserView({ entry, message }: { entry: EntryRecord; message: UserMessage }) {
  const images =
    typeof message.content === 'string'
      ? []
      : message.content.filter((block) => block.type === 'image')
  const text = textOf(message.content)
  return (
    <Message className="group/message mt-3 first:mt-0" from="user">
      <MessageContent>
        <p className="break-words whitespace-pre-wrap">
          <MentionText text={text} />
        </p>
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((image, index) => (
              <ToolImage alt={`Attached image ${index + 1}`} image={image} key={index} />
            ))}
          </div>
        )}
      </MessageContent>
      <MessageActions
        className="-mt-1 justify-end"
        entry={entry}
        text={text}
        timestamp={message.timestamp}
      />
    </Message>
  )
}

function AssistantView({
  entry,
  message,
  blocks,
  results,
  slots,
  busy,
  streaming = false,
}: {
  entry?: EntryRecord
  message: AssistantMessage
  /** Show only these content blocks; the notice and actions go with the last block. */
  blocks?: readonly number[]
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  streaming?: boolean
}) {
  const extensions = useExtensions()
  const labels = messageItems(extensions, 'answerLabels')
  const last = message.content.length - 1
  const final =
    !streaming &&
    message.stopReason === 'stop' &&
    !message.content.some((block) => block.type === 'toolCall') &&
    message.content.some((block) => block.type === 'text' && block.text.trim())
  const ended = !streaming && message.stopReason !== 'toolUse'
  const tail = !blocks || blocks.includes(last)
  const text = message.content
    .flatMap((block) => (block.type === 'text' && block.text.trim() ? [block.text] : []))
    .join('\n\n')
  return (
    <Message
      className={cn(
        'group/message gap-3',
        final && 'rounded-lg border border-success/40 bg-success/5 px-3.5 py-2.5',
      )}
      from="assistant"
    >
      {final && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-success">
          <span className="inline-flex items-center gap-1.5">
            <CheckIcon aria-hidden="true" className="size-3.5" /> Final answer
          </span>
          {entry &&
            labels.map(({ key, extension, version, component: Label }) => (
              <ExtensionBoundary extension={extension} fallback={null} key={key} version={version}>
                <Label entry={entry} />
              </ExtensionBoundary>
            ))}
        </div>
      )}
      {message.content.map((block, index) => {
        if (blocks && !blocks.includes(index)) return null
        switch (block.type) {
          case 'thinking':
            if (!block.thinking && !block.redacted) return null
            return (
              <Reasoning isStreaming={streaming && index === last} key={index}>
                <ReasoningTrigger
                  label={`${streaming && index === last ? 'Thinking' : 'Thought'}${block.redacted ? ' (redacted)' : ''}`}
                />
                <ReasoningContent>{block.thinking}</ReasoningContent>
              </Reasoning>
            )
          case 'text':
            return block.text ? (
              <MessageResponse isAnimating={streaming && index === last} key={index}>
                {block.text}
              </MessageResponse>
            ) : null
          case 'toolCall':
            return (
              <ToolCallBlock
                call={toolCallView(block, {
                  result: results.get(block.id),
                  slot: slots.get(block.id),
                  streaming,
                  busy,
                })}
                key={block.id}
              />
            )
        }
        return null
      })}
      {tail && !streaming && (message.stopReason !== 'toolUse' || message.errorMessage) && (
        <AssistantNotice message={message} />
      )}
      {tail && entry && (text || ended) && (
        <MessageActions entry={entry} text={text} timestamp={message.timestamp} />
      )}
    </Message>
  )
}

function AssistantNotice({ message }: { message: AssistantMessage }) {
  const { stopReason } = message
  const notice =
    stopReason === 'error' ? (
      <div className="flex items-start gap-1.5 text-error">
        <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        <span className="break-words">
          {message.errorMessage ?? 'The provider returned an error'}
        </span>
      </div>
    ) : stopReason === 'aborted' ? (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <CircleStopIcon className="size-3.5" /> aborted
      </div>
    ) : stopReason === 'length' ? (
      <div className="flex items-center gap-1.5 text-warning">
        <CircleAlertIcon className="size-3.5" /> stopped at the output limit
      </div>
    ) : null
  return notice && <div className="font-mono text-[11px]">{notice}</div>
}

function Divider({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 font-mono text-[11px] text-muted-foreground/70 before:h-px before:flex-1 before:bg-border/70 after:h-px after:flex-1 after:bg-border/70',
        className,
      )}
    >
      {children}
    </div>
  )
}

function SystemDivider({ entry, message }: { entry: number; message: SystemMessage }) {
  // In a chat its open state is kept like a card's; elsewhere it opens and closes on its own.
  const fold = useFold(entry)
  const sections = Object.entries(message.sections ?? {})
  const added = message.toolsAdded?.map((tool) => tool.name) ?? []
  const removed = message.toolsRemoved?.map((tool) => tool.name) ?? []
  const parts = [
    sections.length ? `${sections.length} section${sections.length > 1 ? 's' : ''}` : '',
    added.length ? `+${added.length} tool${added.length > 1 ? 's' : ''}` : '',
    removed.length ? `−${removed.length} tool${removed.length > 1 ? 's' : ''}` : '',
  ].filter(Boolean)
  return (
    <Collapsible
      className="group/system"
      {...(fold.folds && { open: fold.open, onOpenChange: fold.setOpen })}
    >
      <CollapsibleTrigger className="w-full">
        <Divider className="hover:text-muted-foreground">
          <span className="flex items-center gap-1">
            <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/system:rotate-90" />
            system prompt{parts.length ? ` · ${parts.join(' · ')}` : ' changed'}
          </span>
        </Divider>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 rounded-md border border-border/70 bg-card/40 px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
        {sections.map(([key, value]) => (
          <div className="flex gap-3" key={key}>
            <span className="w-32 shrink-0 text-foreground/80">{key}</span>
            <span className="truncate">
              {value === null ? 'removed' : `${value.length.toLocaleString()} chars`}
            </span>
          </div>
        ))}
        {added.length > 0 && (
          <div className="flex gap-3">
            <span className="w-32 shrink-0 text-foreground/80">tools</span>
            <span>
              {added.join(' ')}
              {removed.length > 0 && ` · removed ${removed.join(' ')}`}
            </span>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function CompactionView({ entry }: { entry: EntryRecord }) {
  const message = entry.model?.[0]
  const wrapped = message?.role === 'user' ? textOf(message.content) : ''
  const start = wrapped.indexOf('<summary>\n')
  const end = wrapped.lastIndexOf('\n</summary>')
  const summary =
    start >= 0 && end > start ? wrapped.slice(start + '<summary>\n'.length, end) : wrapped
  const reason = (entry.data as { reason?: string } | undefined)?.reason
  return (
    <Collapsible className="group/compaction rounded-lg border border-brand/30 bg-brand/5">
      <CollapsibleTrigger className="flex w-full cursor-pointer flex-col gap-1 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-brand">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/compaction:rotate-90" />
          Conversation condensed{reason ? ` · ${reason}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">
          Prior conversation was condensed into a summary. Earlier messages remain available above.
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-brand/20 px-3.5 py-2.5 text-[13px]">
        <MessageResponse>{summary}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  )
}

function UnknownEntry({ entry }: { entry: EntryRecord }) {
  return (
    <Collapsible className="group/unknown rounded-md border border-dashed border-border font-mono text-[11.5px]">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/unknown:rotate-90" />
        {entry.kind}
        <span className="text-muted-foreground/60">#{entry.id}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-64 overflow-auto border-t border-dashed px-2.5 py-2 text-muted-foreground">
          {JSON.stringify({ data: entry.data, model: entry.model }, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Whether a streaming partial shows anything yet; a reasoning model's first phase is often an empty thinking block. */
function shows(message: AssistantMessage | undefined) {
  return !!message?.content.some((block) =>
    block.type === 'toolCall'
      ? true
      : block.type === 'text'
        ? !!block.text
        : !!block.thinking || !!block.redacted,
  )
}

/** When this page first saw each run, for the working indicator's clock. */
const runSeen = new Map<number, number>()

/** What the run is doing when the transcript alone does not show it. */
function LiveStatus({
  live,
  busy,
  partial,
}: {
  live: LiveState
  busy: boolean
  partial: AssistantMessage | undefined
}) {
  const retry = live.generation?.retry
  const running = (live.tools ?? []).some((slot) => slot.status !== 'done')
  const idle = busy && !shows(partial) && !running
  const now = useNow(100, !!retry || idle)
  const lines: ReactNode[] = []
  if (retry)
    lines.push(
      <span className="flex items-center gap-1.5 text-warning" key="retry">
        <RotateCwIcon className="size-3" />
        retrying in {formatDuration(Math.max(0, retry.at - now))} · attempt{' '}
        {live.generation?.attempt ?? 1} · <span className="truncate">{retry.error}</span>
      </span>,
    )
  if (live.generation?.deferred)
    lines.push(<Shimmer key="deferred">waiting for the provider…</Shimmer>)
  for (const compaction of live.compactions ?? [])
    lines.push(
      <Shimmer key={`compaction-${compaction.taskId}`}>
        {`compacting context · ${compaction.reason}${compaction.attempt > 1 ? ` · attempt ${compaction.attempt}` : ''}…`}
      </Shimmer>,
    )
  if (idle && lines.length === 0) {
    const run = live.run?.taskId
    if (run !== undefined && !runSeen.has(run)) runSeen.set(run, Date.now())
    const since = run === undefined ? undefined : runSeen.get(run)
    const thinking = partial?.content.some((block) => block.type === 'thinking')
    lines.push(
      <span className="flex items-center gap-2" key="working">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
        <Shimmer>{thinking ? 'thinking…' : 'working…'}</Shimmer>
        {since !== undefined && now - since >= 2000 && (
          <span className="text-muted-foreground/60 tabular-nums">
            {formatDuration(now - since)}
          </span>
        )}
      </span>,
    )
  }
  if (lines.length === 0) return null
  return (
    <div className="flex flex-col gap-1 font-mono text-[12px] text-muted-foreground">{lines}</div>
  )
}
