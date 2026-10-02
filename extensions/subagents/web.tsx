import { BotIcon, MessageSquareIcon, NetworkIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Message, MessageResponse } from '@/components/ai/message'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import {
  cn,
  defineWebExtension,
  useAction,
  useConversations,
  useTasks,
  useToolDuration,
  useUltimate,
} from '@/sdk'
import type { ConversationSummary, ToolCallView } from '@/sdk'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 text-[10px] leading-4 text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

function BusyDot({ className }: { className?: string }) {
  return (
    <span className={cn('size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand', className)} />
  )
}

/** One `subagent` call: who got which task, how the child is doing, its answer, and a way into it. */
function SubagentCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { switchConversation } = useUltimate()
  const conversations = useConversations()
  const action = text(call.args.action) || 'start'
  const details = call.details as { conversationId?: number; background?: boolean } | undefined
  const childId =
    details?.conversationId ?? (typeof call.args.id === 'number' ? call.args.id : undefined)
  const child = conversations.find((conversation) => conversation.id === childId)
  const agent = text(call.args.agent) || child?.label
  const background = call.args.background === true || details?.background === true
  const instruction = action === 'start' ? text(call.args.task) : text(call.args.text)
  const finished = call.status === 'done' || call.status === 'error'
  const working = child?.busy && (background || !finished)
  const title: ReactNode =
    action === 'start' ? (
      <>
        <span className="text-brand">{agent ?? '…'}</span> {instruction}
      </>
    ) : action === 'list' ? (
      'list children'
    ) : (
      <>
        {action} <span className="text-foreground/80">#{childId ?? '?'}</span>
        {call.args.steer === true && ' (steer)'} {instruction}
      </>
    )
  return (
    <Tool defaultOpen={!finished || call.status === 'error'}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={
            <>
              {background && <Tag>bg</Tag>}
              {working && (
                <span className="flex items-center gap-1.5 text-brand">
                  <BusyDot /> working
                </span>
              )}
              {duration && <span>{duration}</span>}
            </>
          }
          name="subagent"
          state={call.status}
          title={title}
        />
        {childId !== undefined && (
          <Button
            className="mr-1 h-6 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => switchConversation(childId)}
            size="sm"
            title={`Show conversation #${childId}`}
            variant="ghost"
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            open #{childId}
          </Button>
        )}
      </div>
      <ToolContent>
        {instruction && (
          <ToolSection label={action === 'start' ? 'Task' : 'Message'}>
            <p className="font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/90">
              {instruction}
            </p>
          </ToolSection>
        )}
        {!finished && call.status !== 'interrupted' && (
          <ToolSection>
            <Shimmer className="text-[12px]">
              {child?.busy ? `${agent ?? 'subagent'} is working…` : 'starting…'}
            </Shimmer>
          </ToolSection>
        )}
        {call.status === 'done' && action === 'list' ? (
          <ChildList output={call.output} />
        ) : call.status === 'done' && call.output ? (
          <ToolSection label={background && action !== 'wait' ? 'Result' : 'Answer'}>
            <Message className="font-sans text-[13px]" from="assistant">
              <MessageResponse>{call.output}</MessageResponse>
            </Message>
          </ToolSection>
        ) : null}
        {call.status === 'error' && <ToolOutput isError output={call.output} />}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

/** The `list` action's JSON rows. */
function ChildList({ output }: { output: string }) {
  const { switchConversation } = useUltimate()
  let rows: { conversationId: number; agent: string; background: boolean; busy: boolean }[]
  try {
    rows = JSON.parse(output)
  } catch {
    return <ToolOutput output={output} />
  }
  return (
    <ToolSection label={`${rows.length} children`}>
      {rows.map((row) => (
        <button
          className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-accent/50"
          key={row.conversationId}
          onClick={() => switchConversation(row.conversationId)}
          type="button"
        >
          {row.busy ? <BusyDot /> : <span className="size-1.5" />}
          <span className="text-brand">{row.agent}</span>
          <span className="text-muted-foreground/70">#{row.conversationId}</span>
          {row.background && <Tag>bg</Tag>}
        </button>
      ))}
    </ToolSection>
  )
}

function Node({
  conversation,
  children,
  depth,
}: {
  conversation: ConversationSummary
  children: Map<number, ConversationSummary[]>
  depth: number
}) {
  const { conversationId, switchConversation } = useUltimate()
  const graph = useTasks()
  // The graph holds only live tasks: a background child is marked while its owner, the anchor, lives.
  const background =
    conversation.ownerTaskId !== undefined &&
    graph?.tasks[conversation.ownerTaskId]?.background === true
  const shown = conversation.id === conversationId
  const main = conversation.parentConversationId === undefined
  const Icon = main ? MessageSquareIcon : BotIcon
  return (
    <>
      <button
        className={cn(
          'flex h-7 w-full min-w-0 items-center gap-1.5 pr-3 text-left font-mono text-[11.5px] transition-colors hover:bg-accent/50',
          shown && 'bg-accent/70',
        )}
        onClick={() => switchConversation(conversation.id)}
        style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
        type="button"
      >
        {depth > 0 && <span className="-ml-2 shrink-0 text-muted-foreground/40">└</span>}
        <Icon className={cn('size-3.5 shrink-0', shown ? 'text-brand' : 'text-muted-foreground')} />
        <span className={cn('shrink-0', shown ? 'text-foreground' : 'text-foreground/85')}>
          {conversation.id === 1
            ? 'main'
            : (conversation.label ?? (main ? 'conversation' : 'subagent'))}
        </span>
        <span className="shrink-0 text-muted-foreground/60">#{conversation.id}</span>
        {conversation.title && conversation.id !== 1 && (
          <span
            className="min-w-0 truncate font-sans text-[12px] text-muted-foreground"
            title={conversation.title}
          >
            {conversation.title}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {background && <Tag>bg</Tag>}
          {conversation.busy && <BusyDot />}
        </span>
      </button>
      {(children.get(conversation.id) ?? []).map((child) => (
        <Node children={children} conversation={child} depth={depth + 1} key={child.id} />
      ))}
    </>
  )
}

type Source = 'builtin' | 'user' | 'project'
/** The `definitions` action: what `start` can name, and the files that failed to parse. */
interface Discovery {
  definitions: {
    name: string
    description: string
    path: string
    source: Source
    model?: { provider: string; modelId: string }
    thinking?: string
    tools?: string[]
  }[]
  errors: { name: string; path: string; source: Source; error: string }[]
}

function Heading({ children, meta }: { children: ReactNode; meta: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
      {children}
      <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">{meta}</span>
    </div>
  )
}

/** Definitions are reread at every start; the list refetches when the window regains focus, as after an edit. */
function Definitions() {
  const { data, refetch } = useAction<Discovery>('subagents', 'definitions')
  useEffect(() => {
    const refresh = () => void refetch()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refetch])
  if (!data) return null
  const { definitions, errors } = data
  return (
    <div className="pt-4">
      <Heading
        meta={
          <>
            {definitions.length}
            {errors.length > 0 && <span className="text-error"> · {errors.length} invalid</span>}
          </>
        }
      >
        Definitions
      </Heading>
      {definitions.map((definition) => (
        <div
          className="px-3 py-1"
          key={definition.path}
          title={[
            definition.path,
            definition.model && `model: ${definition.model.provider}/${definition.model.modelId}`,
            `tools: ${definition.tools?.join(', ') ?? 'inherited'}`,
          ]
            .filter(Boolean)
            .join('\n')}
        >
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
            <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-foreground/85">{definition.name}</span>
            {definition.source !== 'builtin' && <Tag>{definition.source}</Tag>}
            <span className="ml-auto truncate pl-2 text-[10.5px] text-muted-foreground/70">
              {definition.model?.modelId ?? 'inherits model'}
              {definition.thinking && ` · ${definition.thinking}`}
            </span>
          </div>
          <p className="line-clamp-2 pl-5 font-sans text-[12px] leading-snug text-muted-foreground">
            {definition.description}
          </p>
        </div>
      ))}
      {errors.map((error) => (
        <div className="px-3 py-1" key={error.path} title={error.path}>
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-error">
            <BotIcon className="size-3.5 shrink-0" />
            <span className="shrink-0">{error.name}</span>
            <Tag>{error.source}</Tag>
          </div>
          <p className="line-clamp-3 pl-5 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap text-error/80">
            {error.error.replace(/^Error: /, '')}
          </p>
        </div>
      ))}
      {definitions.length === 0 && errors.length === 0 && (
        <p className="px-3 font-sans text-[12px] leading-relaxed text-muted-foreground/70">
          No definitions yet: add Markdown files to{' '}
          <code className="font-mono">.ultimate/agents/</code>
        </p>
      )}
    </div>
  )
}

/** Main and its subagents as a tree; click one to show it, and the composer talks to it. Below, the definitions. */
function AgentsPanel() {
  const conversations = useConversations()
  const ids = new Set(conversations.map((conversation) => conversation.id))
  const children = Map.groupBy(
    conversations.filter((conversation) => conversation.parentConversationId !== undefined),
    (conversation) => conversation.parentConversationId as number,
  )
  const roots = conversations.filter(
    (conversation) =>
      conversation.parentConversationId === undefined ||
      !ids.has(conversation.parentConversationId),
  )
  const busy = conversations.filter((conversation) => conversation.busy).length
  return (
    <div className="py-2">
      <Heading
        meta={
          <>
            {conversations.length}
            {busy > 0 && ` · ${busy} working`}
          </>
        }
      >
        Conversations
      </Heading>
      {roots.map((conversation) => (
        <Node children={children} conversation={conversation} depth={0} key={conversation.id} />
      ))}
      {conversations.length <= 1 && (
        <p className="px-3 pt-3 font-sans text-[12px] leading-relaxed text-muted-foreground/70">
          Subagents appear here when the agent delegates with the{' '}
          <code className="font-mono">subagent</code> tool. Click one to watch it; the composer then
          steers it.
        </p>
      )}
      <Definitions />
    </div>
  )
}

export default defineWebExtension({
  tools: { subagent: SubagentCall },
  panels: [{ id: 'agents', title: 'Agents', icon: NetworkIcon, component: AgentsPanel, order: -6 }],
  commands: [
    {
      id: 'subagents.open',
      title: 'Show conversations and subagents',
      run: (context) => context.openPanel('agents'),
    },
  ],
})
