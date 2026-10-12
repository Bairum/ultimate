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
import { Fragment, memo, useMemo } from 'react'
import type { ReactNode } from 'react'
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
import { rendererFor } from '../sdk/registry.ts'
import { ExtensionBoundary } from './boundary.tsx'
import { column } from './layout.ts'
import { indexTools, partialOf, slotsOf, toolCallView } from './model.ts'
import type { ToolResult } from './model.ts'
import { ToolCallBlock } from './tool-call.tsx'

/** The shown conversation; `dock` fits it into a narrow side region. */
export function Transcript({ dock }: { dock?: boolean }) {
  const { entries, live, busy, loading } = useConversation()
  const { results, calls } = useMemo(() => indexTools(entries), [entries])
  const slots = useMemo(() => slotsOf(live), [live])
  const partial = partialOf(live)
  const visible = entries.filter(
    (entry) => !(entry.kind === 'pi.tool-result' && calls.has(toolCallId(entry) ?? '')),
  )
  return (
    <Conversation className="min-h-0">
      <ConversationContent className={cn(column(dock), 'gap-3 pt-6 pb-10')}>
        {!loading && visible.length === 0 && !partial && <EmptyState />}
        {visible.map((entry) => (
          <EntryView busy={busy} entry={entry} key={entry.id} results={results} slots={slots} />
        ))}
        {partial && (
          <AssistantView busy message={partial} results={results} slots={slots} streaming />
        )}
        <LiveStatus busy={busy} live={live} partial={partial} />
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
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
  const custom = rendererFor(useExtensions(), 'entries', entry.kind)
  const core = coreEntry(entry, results, slots, busy)
  if (custom) {
    const Renderer = custom.component
    return (
      <ExtensionBoundary
        extension={custom.extension}
        fallback={core}
        key={custom.extension}
        version={custom.version}
      >
        <Renderer core={core} entry={entry} />
      </ExtensionBoundary>
    )
  }
  return core
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
  const summary = message?.role === 'user' ? textOf(message.content) : ''
  const reason = (entry.data as { reason?: string } | undefined)?.reason
  return (
    <Collapsible className="group/compaction">
      <CollapsibleTrigger className="w-full">
        <Divider className="hover:text-muted-foreground">
          <span className="flex items-center gap-1">
            <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/compaction:rotate-90" />
            context compacted{reason ? ` · ${reason}` : ''}
          </span>
        </Divider>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 rounded-md border border-border/70 bg-card/40 px-3.5 py-2.5 text-[13px] text-muted-foreground">
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
