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
  startTransition,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
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
import { Message, MessageContent, MessageResponse } from '@/components/ai/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai/reasoning'
import { Shimmer } from '@/components/ai/shimmer'
import { ToolImage } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { elidePath, formatDuration, formatTime, shortenPath } from '../sdk/format.ts'
import {
  TranscriptContext,
  useConversation,
  useExtensions,
  useModels,
  useNow,
  useStore,
  useSystem,
} from '../sdk/hooks.ts'
import { entryRenderers, messageItems } from '../sdk/registry.ts'
import { covered } from '../sdk/resume.ts'
import { ExtensionBoundary } from './boundary.tsx'
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

/** Rows a conversation shows at once when it opens; the rest follow without blocking. */
const firstRows = 30

function TranscriptEntries() {
  const { id, entries: active, live, busy, loading } = useConversation()
  const [history, setHistory] = useState<EntryRecord[]>([])
  const previousActive = useRef(active)
  const [tailSpace, setTailSpace] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [exhausted, setExhausted] = useState(false)
  const [before, setBefore] = useState<number>()
  const request = useRef<AbortController | null>(null)
  const anchor = useRef<{ entryId: number; toolCallId?: string; top: number } | null>(null)
  const { contentRef, scrollRef, stopScroll } = useStickToBottomContext()
  // Retain already displayed rows when a live compaction replaces the active context.
  const entries = useMemo(() => {
    const rows = new Map(history.map((entry) => [entry.id, entry]))
    const condensed = active.some(
      (entry) =>
        (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') &&
        !previousActive.current.some((old) => old.id === entry.id),
    )
    if (condensed) for (const entry of previousActive.current) rows.set(entry.id, entry)
    for (const entry of active) rows.set(entry.id, entry)
    return [...rows.values()].toSorted((a, b) => a.id - b.id)
  }, [history, active])
  useLayoutEffect(() => {
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
      setBefore(Math.max(...active.map((entry) => entry.id)))
      setExhausted(false)
      const retained = previousActive.current
      setHistory((previous) => {
        const rows = new Map(previous.map((entry) => [entry.id, entry]))
        for (const entry of retained) rows.set(entry.id, entry)
        return [...rows.values()]
      })
    }
    previousActive.current = active
  }, [active])
  useEffect(() => () => request.current?.abort(), [])
  useLayoutEffect(() => {
    if (anchor.current && scrollRef.current) {
      const { entryId, toolCallId: callId, top } = anchor.current
      const entry = contentRef.current?.querySelector(`[data-entry-id="${entryId}"]`)
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
  const loadEarlier = async () => {
    if (id === undefined || request.current || !entries.length) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    try {
      // Scan stored history independently of display order: retained suffixes can precede
      // discarded compaction markers which a minimum-active-ID cursor would skip.
      const page = await api.history(id, before ?? entries.at(-1)!.id, controller.signal)
      if (controller.signal.aborted) return
      const { calls: mergedCalls } = indexTools([...entries, ...page.entries])
      const survivors = new Set<number>(
        entries
          .filter(
            (entry) =>
              !(entry.kind === 'pi.tool-result' && mergedCalls.has(toolCallId(entry) ?? '')),
          )
          .map((entry) => entry.id),
      )
      const candidates = [
        ...(contentRef.current?.querySelectorAll('[data-entry-id]') ?? []),
      ].filter(
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
      stopScroll()
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
  }
  const { results, calls } = useMemo(() => indexTools(entries), [entries])
  // Keyed on the tools, not `live`: a streamed token must not re-render every row.
  const slots = useMemo(() => slotsOf(live.tools), [live.tools])
  const partial = partialOf(live)
  const visible = entries.filter(
    (entry) => !(entry.kind === 'pi.tool-result' && calls.has(toolCallId(entry) ?? '')),
  )
  // Opening a long conversation renders its end first, then the rest as an interruptible transition.
  const [whole, setWhole] = useState(false)
  useEffect(() => {
    if (!loading) startTransition(() => setWhole(true))
  }, [loading])
  const shown = whole ? visible : visible.slice(-firstRows)
  // Reveal a stored row without the auto-follow animation overriding the jump; an older row needs every row first.
  useEvent('ultimate:reveal-entry', (value) => {
    const target = value as { conversationId?: number; entryId?: number } | undefined
    if (target?.conversationId !== id || !Number.isSafeInteger(target?.entryId)) return
    if (!whole) flushSync(() => setWhole(true))
    const element = contentRef.current?.querySelector(`[data-entry-id="${target?.entryId}"]`)
    if (element) {
      stopScroll()
      element.scrollIntoView({ block: 'start' })
    }
  })
  return (
    <TranscriptContext value={entries}>
      {!loading && entries.length > 0 && !exhausted && (
        <div className="flex flex-col items-center gap-1">
          <Button
            className="cursor-pointer"
            disabled={pending}
            onClick={() => void loadEarlier()}
            size="sm"
            variant="ghost"
          >
            {pending
              ? 'Loading earlier messages…'
              : error
                ? 'Retry loading earlier messages'
                : 'Load earlier messages'}
          </Button>
          {error && (
            <p className="text-xs text-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {!loading && visible.length === 0 && !partial && <EmptyState />}
      {shown.map((entry) => (
        <div
          className="empty:hidden"
          data-conversation-id={id}
          data-entry-id={entry.id}
          key={entry.id}
        >
          <EntryView busy={busy} entry={entry} results={results} slots={slots} />
        </div>
      ))}
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

/** What this Ultimate is and runs on, before the first message. */
function EmptyState() {
  const system = useSystem()
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
  return (
    <ConversationEmptyState className="min-h-[55vh]">
      <div className="w-full max-w-md font-mono text-[12px]">
        <div className="text-[13px] font-semibold tracking-[0.3em] text-brand">ULTIMATE</div>
        <div className="mt-1 font-sans text-[13px] text-muted-foreground">
          {!system || system.project.root === system.code.ultimateRoot
            ? 'A coding agent that edits this repository, itself included.'
            : `A coding agent that edits ${system.project.name}, and can change itself too.`}
        </div>
        <div className="mt-5 grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 border-t border-border/70 pt-4 text-left">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <span className="text-muted-foreground/70">{label}</span>
              <span className="truncate text-foreground/85">{value}</span>
            </Fragment>
          ))}
        </div>
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
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}

const EntryView = memo(function EntryView({ entry, results, slots, busy }: RowProps) {
  // Renderers compose in discovery order: each receives the one before it as `core`, and falls back to it.
  return entryRenderers(useExtensions(), entry.kind).reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary extension={extension} fallback={inner} key={extension} version={version}>
        <Renderer core={inner} entry={entry} />
      </ExtensionBoundary>
    ),
    coreEntry(entry, results, slots, busy),
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
  if (a.entry !== b.entry) return false
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
): ReactNode {
  const message = entry.model?.[0]
  switch (entry.kind) {
    case 'pi.user':
      return message?.role === 'user' ? <UserView entry={entry} message={message} /> : null
    case 'pi.assistant':
      return message?.role === 'assistant' ? (
        <AssistantView
          busy={busy}
          entry={entry}
          message={message}
          results={results}
          slots={slots}
        />
      ) : null
    case 'pi.system':
      return message?.role === 'system' ? <SystemDivider message={message} /> : null
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
        <p className="break-words whitespace-pre-wrap">{text}</p>
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
  results,
  slots,
  busy,
  streaming = false,
}: {
  entry?: EntryRecord
  message: AssistantMessage
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
      {!streaming && (message.stopReason !== 'toolUse' || message.errorMessage) && (
        <AssistantNotice message={message} />
      )}
      {entry && (text || ended) && (
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

function SystemDivider({ message }: { message: SystemMessage }) {
  const sections = Object.entries(message.sections ?? {})
  const added = message.toolsAdded?.map((tool) => tool.name) ?? []
  const removed = message.toolsRemoved?.map((tool) => tool.name) ?? []
  const parts = [
    sections.length ? `${sections.length} section${sections.length > 1 ? 's' : ''}` : '',
    added.length ? `+${added.length} tool${added.length > 1 ? 's' : ''}` : '',
    removed.length ? `−${removed.length} tool${removed.length > 1 ? 's' : ''}` : '',
  ].filter(Boolean)
  return (
    <Collapsible className="group/system">
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
