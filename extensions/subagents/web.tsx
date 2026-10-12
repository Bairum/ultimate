import {
  BotIcon,
  GitBranchIcon,
  GitMergeIcon,
  MessageSquareIcon,
  NetworkIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
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
  useTasks,
  useToolDuration,
  useUiState,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/data.tsx'
import {
  stateLabel,
  useWorkspaceAction,
  useWorkspaceConversations as useConversations,
} from '../workspaces/data.tsx'
import type { Workspace as Isolate, WorkspaceInfo } from '../workspaces/types.ts'
import { hiddenConversationIds } from '../conversations/visible.tsx'
import { DefinitionDialog, Definitions } from './definitions.tsx'
import { Heading, Tag, useRefresh } from './parts.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function BusyDot({ className }: { className?: string }) {
  return (
    <span className={cn('size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand', className)} />
  )
}

function StateTag({ isolate }: { isolate: Isolate }) {
  if (isolate.state === 'ready') return null
  return (
    <Tag
      className={cn(
        'font-mono',
        isolate.state === 'failed' ? 'border-error/40 text-error' : 'text-muted-foreground/70',
      )}
    >
      <span title={isolate.landed ? `Last landed ${isolate.landed.slice(0, 7)}` : undefined}>
        {stateLabel(isolate)}
      </span>
    </Tag>
  )
}

/** The call card's compact workspace: branch and state from the child's summary. */
function IsolateBadge({ childId }: { childId: number }) {
  const isolate = useConversations().find((conversation) => conversation.id === childId)?.workspace
  if (!isolate) return null
  return (
    <span
      className="flex items-center gap-1 font-mono"
      title={`${isolate.branch}\n${isolate.path}`}
    >
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="shrink-0">W{childId}</span>
      <StateTag isolate={isolate} />
    </span>
  )
}

/** One `subagent` call: who got which task, how the child is doing, its answer, and a way into it. */
function SubagentCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const { switchConversation } = useUltimate()
  const conversations = useConversations()
  const action = text(call.args.action) || 'start'
  const details = call.details as
    | { conversationId?: number; background?: boolean; yielded?: boolean }
    | undefined
  const childId =
    details?.conversationId ?? (typeof call.args.id === 'number' ? call.args.id : undefined)
  const child = conversations.find((conversation) => conversation.id === childId)
  const agent = text(call.args.agent) || child?.label
  const background = call.args.background === true || details?.background === true
  const instruction = action === 'start' ? text(call.args.task) : text(call.args.text)
  const finished = call.status === 'done' || call.status === 'error'
  const yielded = details?.yielded === true
  const working = child?.busy && (background || yielded || !finished)
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
              {childId !== undefined && <IsolateBadge childId={childId} />}
              {background && <Tag>bg</Tag>}
              {yielded && <Tag>wait yielded</Tag>}
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
          <ToolSection
            label={yielded ? 'Wait status' : background && action !== 'wait' ? 'Result' : 'Answer'}
          >
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

/** Below a child's row: its checkout, and Land and Remove. Results stay inline. */
function IsolateActions({
  child,
  isolate,
  refetch,
  depth,
}: {
  child: ConversationSummary
  isolate: WorkspaceInfo
  refetch: () => unknown
  depth: number
}) {
  const [confirming, setConfirming] = useState(false)
  const { pending, outcome, land, remove } = useWorkspaceAction(child.id, refetch)
  const disabled = child.busy || pending !== undefined || isolate.state === 'preparing'
  // Under the row's icon.
  const indent = { paddingLeft: `${1.3 + depth}rem` }
  return (
    <div className="pb-1 font-mono text-[11px] text-muted-foreground">
      <div className="flex h-6 min-w-0 items-center gap-1.5 pr-2" style={indent}>
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate" title={`${isolate.branch}\n${isolate.path}`}>
          {isolate.branch}
        </span>
        {isolate.state !== 'removed' && !confirming && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
            <Button
              className="h-5 gap-1 px-1.5 text-[11px]"
              disabled={disabled || isolate.state !== 'ready'}
              onClick={() => void land()}
              size="xs"
              variant="ghost"
            >
              <GitMergeIcon className="size-3" />
              {pending === 'land' ? 'Landing…' : 'Land'}
            </Button>
            <Button
              className="h-5 gap-1 px-1.5 text-[11px] hover:text-error"
              disabled={disabled}
              onClick={() => setConfirming(true)}
              size="xs"
              variant="ghost"
            >
              <Trash2Icon className="size-3" />
              {pending === 'discard' ? 'Removing…' : 'Remove'}
            </Button>
          </span>
        )}
      </div>
      {isolate.error && (
        <div className="pr-2 text-error" style={indent}>
          {isolate.error}
        </div>
      )}
      {confirming && (
        <div className="flex min-w-0 items-center gap-1.5 pr-2" style={indent}>
          <span className="min-w-0 font-sans text-[12px] leading-snug text-foreground/85">
            Remove this checkout? Its branch and commits stay.
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
            <Button
              className="h-5 px-1.5 text-[11px] text-error hover:bg-error/10 hover:text-error"
              disabled={child.busy}
              onClick={() => {
                setConfirming(false)
                void remove()
              }}
              size="xs"
              variant="ghost"
            >
              Remove
            </Button>
            <Button
              className="h-5 px-1.5 text-[11px]"
              onClick={() => setConfirming(false)}
              size="xs"
              variant="ghost"
            >
              Cancel
            </Button>
          </span>
        </div>
      )}
      {outcome && (
        <p
          className={cn(
            'pr-3 leading-snug break-words whitespace-pre-wrap',
            outcome.error && 'text-error',
          )}
          style={indent}
        >
          {outcome.text}
        </p>
      )}
    </div>
  )
}

/** One conversation in the tree; click it to show it. `meta` goes before its marks. */
function Row({
  conversation,
  depth,
  meta,
}: {
  conversation: ConversationSummary
  depth: number
  meta?: ReactNode
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
    <button
      className={cn(
        'flex w-full min-w-0 items-center gap-1.5 py-1.5 pr-3 text-left font-mono text-[11.5px] transition-colors hover:bg-accent/50',
        shown && 'bg-accent/70',
      )}
      onClick={() => switchConversation(conversation.id)}
      style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
      type="button"
    >
      {depth > 0 && <span className="-ml-2 shrink-0 text-muted-foreground/40">└</span>}
      <Icon className={cn('size-3.5 shrink-0', shown ? 'text-brand' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate font-sans text-[12px] text-foreground/90"
          title={conversation.title}
        >
          {conversation.title ||
            conversation.label ||
            (main ? 'Untitled conversation' : 'Subagent')}
        </span>
        <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground/60">
          <span>#{conversation.id}</span>
          {conversation.workspace && (
            <span title={`${conversation.workspace.branch}\n${conversation.workspace.path}`}>
              · W{conversation.id}
            </span>
          )}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
        {meta}
        {background && <Tag>bg</Tag>}
        {conversation.busy && <BusyDot />}
      </span>
    </button>
  )
}

/**
 * A subagent's row, with its workspace's state and commits ahead and the checkout and actions below. Refetched when
 * the child or its parent settles, since either may have committed or landed, and when its workspace record changes.
 */
function Child({
  conversation,
  parent,
  depth,
}: {
  conversation: ConversationSummary
  parent: ConversationSummary
  depth: number
}) {
  const recorded = conversation.workspace
  const { data: isolate, refetch } = useAction<WorkspaceInfo | null>(
    'workspaces',
    'info',
    { id: conversation.id },
    { enabled: !!recorded },
  )
  const settled = recorded
    ? `${recorded.state} ${recorded.error ?? ''} ${recorded.landed ?? ''}`
    : ''
  useRefresh(() => recorded && refetch(), `${conversation.busy} ${parent.busy} ${settled}`)
  return (
    <>
      <Row
        conversation={conversation}
        depth={depth}
        meta={
          isolate && (
            <>
              <StateTag isolate={isolate} />
              {isolate.ahead !== null && isolate.ahead > 0 && (
                <span
                  className="text-[10.5px] text-muted-foreground/80"
                  title={`${isolate.ahead} commit${isolate.ahead === 1 ? '' : 's'} on the branch that the parent checkout does not have`}
                >
                  ↑{isolate.ahead}
                </span>
              )}
            </>
          )
        }
      />
      {isolate && (
        <IsolateActions child={conversation} depth={depth} isolate={isolate} refetch={refetch} />
      )}
    </>
  )
}

function Node({
  conversation,
  parent,
  children,
  depth,
}: {
  conversation: ConversationSummary
  parent?: ConversationSummary
  children: Map<number, ConversationSummary[]>
  depth: number
}) {
  return (
    <>
      {parent ? (
        <Child conversation={conversation} depth={depth} parent={parent} />
      ) : (
        <Row conversation={conversation} depth={depth} />
      )}
      {(children.get(conversation.id) ?? []).map((child) => (
        <Node
          children={children}
          conversation={child}
          depth={depth + 1}
          key={child.id}
          parent={conversation}
        />
      ))}
    </>
  )
}

/** Main and its subagents as a tree; click one to show it, and the composer talks to it. Below, the definitions. */
function AgentsPanel() {
  const all = useConversations()
  const [archived] = useUiState<number[]>('ext.conversations.archived', [])
  const hidden = hiddenConversationIds(all, archived)
  const conversations = all.filter((conversation) => !hidden.has(conversation.id))
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
  slots: { overlay: [DefinitionDialog] },
  commands: [
    {
      id: 'subagents.open',
      title: 'Show conversations and subagents',
      run: (context) => context.openPanel('agents'),
    },
  ],
})
