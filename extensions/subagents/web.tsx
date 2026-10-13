import { GitBranchIcon, NetworkIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
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
import { cn, defineWebExtension, useConversation, useToolDuration, useUltimate } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { stateLabel, useWorkspaceConversations as useConversations } from '../workspaces/data.tsx'
import type { Workspace as Isolate } from '../workspaces/types.ts'
import { DefinitionDialog, Definitions } from './definitions.tsx'
import { Tag } from './parts.tsx'
import { AgentInbox, AgentInput, AgentMessages, openAgentSource } from './messages.tsx'

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
  const { id } = useConversation()
  const conversations = useConversations()
  const action = text(call.args.action) || 'start'
  const details = call.details as
    | { conversationId?: number; background?: boolean; yielded?: boolean; answerId?: number }
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
            onClick={(event) => {
              const entry = Number(
                event.currentTarget.closest('[data-entry-id]')?.getAttribute('data-entry-id'),
              )
              if (id)
                openAgentSource(
                  switchConversation,
                  { conversation: childId, entry: details?.answerId },
                  { conversation: id, ...(entry ? { entry } : {}) },
                )
            }}
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

export default defineWebExtension({
  tools: { subagent: SubagentCall },
  panels: [{ id: 'agents', title: 'Agents', icon: NetworkIcon, component: Definitions, order: -6 }],
  entries: { 'pi.user': AgentInput },
  inbox: AgentInbox,
  slots: { overlay: [DefinitionDialog], 'header.right': [AgentMessages] },
  commands: [
    {
      id: 'subagents.open',
      title: 'Show agent definitions',
      run: (context) => context.openPanel('agents'),
    },
  ],
})
