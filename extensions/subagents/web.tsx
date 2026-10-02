import { BotIcon, MessageSquareIcon, NetworkIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
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
import { cn, defineWebExtension, useConversations, useToolDuration, useUltimate } from '@/sdk'
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
  const childId =
    (call.details as { conversationId?: number } | undefined)?.conversationId ??
    (typeof call.args.id === 'number' ? call.args.id : undefined)
  const child = conversations.find((conversation) => conversation.id === childId)
  const agent = text(call.args.agent) || child?.agent
  const background = call.args.background === true || child?.background
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
          {conversation.id === 1 ? 'main' : (conversation.agent ?? 'subagent')}
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
          {conversation.background && <Tag>bg</Tag>}
          {conversation.busy && <BusyDot />}
        </span>
      </button>
      {(children.get(conversation.id) ?? []).map((child) => (
        <Node children={children} conversation={child} depth={depth + 1} key={child.id} />
      ))}
    </>
  )
}

/** Main and its subagents as a tree; click one to show it, and the composer talks to it. */
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
      <div className="flex items-center gap-2 px-3 pb-2 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
        Conversations
        <span className="ml-auto tracking-normal normal-case text-muted-foreground/70">
          {conversations.length}
          {busy > 0 && ` · ${busy} working`}
        </span>
      </div>
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
