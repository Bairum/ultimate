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
  RotateCwIcon,
} from 'lucide-react'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
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
import { elidePath, formatDuration, formatTokens, shortenPath } from '../sdk/format.ts'
import { useConversation, useExtensions, useModels, useNow, useSystem } from '../sdk/hooks.ts'
import { entryRenderers } from '../sdk/registry.ts'
import { ExtensionBoundary } from './boundary.tsx'
import { column } from './layout.ts'
import { indexTools, partialOf, slotsOf, toolCallView } from './model.ts'
import type { ToolResult } from './model.ts'
import { ToolCallBlock } from './tool-call.tsx'

/** The shown conversation; `dock` fits it into a narrow side region. */
export function Transcript({ dock }: { dock?: boolean }) {
  const { id } = useConversation()
  return (
    <Conversation className="min-h-0">
      <ConversationContent className={cn(column(dock), 'gap-3 pt-6 pb-10')}>
        <EntryNavigation conversationId={id} />
        <TranscriptEntries key={id} />
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

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
  const slots = useMemo(() => slotsOf(live), [live])
  const partial = partialOf(live)
  const visible = entries.filter(
    (entry) => !(entry.kind === 'pi.tool-result' && calls.has(toolCallId(entry) ?? '')),
  )
  return (
    <>
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
      {visible.map((entry) => (
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
    </>
  )
}

/** Reveal a stored row without the transcript's auto-follow animation overriding the jump. */
function EntryNavigation({ conversationId }: { conversationId?: number }) {
  const { contentRef, stopScroll } = useStickToBottomContext()
  useEvent('ultimate:reveal-entry', (value) => {
    const target = value as { conversationId?: number; entryId?: number } | undefined
    if (target?.conversationId !== conversationId || !Number.isSafeInteger(target?.entryId)) return
    const element = contentRef.current?.querySelector(`[data-entry-id="${target?.entryId}"]`)
    if (element) {
      stopScroll()
      element.scrollIntoView({ block: 'start' })
    }
  })
  return null
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

const EntryView = memo(function EntryView({
  entry,
  results,
  slots,
  busy,
}: {
  entry: EntryRecord
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
}) {
  // Renderers compose in folder order: each receives the one before it as `core`, and falls back to it.
  return entryRenderers(useExtensions(), entry.kind).reduce<ReactNode>(
    (inner, { extension, version, component: Renderer }) => (
      <ExtensionBoundary extension={extension} fallback={inner} key={extension} version={version}>
        <Renderer core={inner} entry={entry} />
      </ExtensionBoundary>
    ),
    coreEntry(entry, results, slots, busy),
  )
})

function coreEntry(
  entry: EntryRecord,
  results: Map<string, ToolResult>,
  slots: Map<string, ToolSlot>,
  busy: boolean,
): ReactNode {
  const message = entry.model?.[0]
  switch (entry.kind) {
    case 'pi.user':
      return message?.role === 'user' ? <UserView message={message} /> : null
    case 'pi.assistant':
      return message?.role === 'assistant' ? (
        <AssistantView busy={busy} message={message} results={results} slots={slots} />
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

function UserView({ message }: { message: UserMessage }) {
  const images =
    typeof message.content === 'string'
      ? []
      : message.content.filter((block) => block.type === 'image')
  return (
    <Message className="mt-3 first:mt-0" from="user">
      <MessageContent>
        <p className="break-words whitespace-pre-wrap">{textOf(message.content)}</p>
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((image, index) => (
              <ToolImage alt={`Attached image ${index + 1}`} image={image} key={index} />
            ))}
          </div>
        )}
      </MessageContent>
    </Message>
  )
}

function AssistantView({
  message,
  results,
  slots,
  busy,
  streaming = false,
}: {
  message: AssistantMessage
  results: Map<string, ToolResult>
  slots: Map<string, ToolSlot>
  busy: boolean
  streaming?: boolean
}) {
  const last = message.content.length - 1
  const final =
    !streaming &&
    message.stopReason === 'stop' &&
    !message.content.some((block) => block.type === 'toolCall') &&
    message.content.some((block) => block.type === 'text' && block.text.trim())
  return (
    <Message
      className={cn(
        'group/assistant gap-3',
        final && 'rounded-lg border border-success/40 bg-success/5 px-3.5 py-2.5',
      )}
      from="assistant"
    >
      {final && (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-success">
          <CheckIcon aria-hidden="true" className="size-3.5" /> Final answer
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
        <AssistantFooter message={message} />
      )}
    </Message>
  )
}

function AssistantFooter({ message }: { message: AssistantMessage }) {
  const { usage, stopReason } = message
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
  const tokens = usage.input + usage.cacheRead + usage.cacheWrite
  return (
    <div className="flex flex-col gap-1 font-mono text-[11px]">
      {notice}
      {tokens > 0 && (
        <div className="text-muted-foreground/60 opacity-0 transition-opacity group-hover/assistant:opacity-100">
          {message.model} · ↑{formatTokens(tokens)} ↓{formatTokens(usage.output)}
          {usage.cost.total > 0 ? ` · $${usage.cost.total.toFixed(4)}` : ''}
        </div>
      )}
    </div>
  )
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
