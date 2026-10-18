import type { EntryRecord, InboxItem } from '@earendil-works/pi-durable'
import { ArrowLeftIcon, BotIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { events, useEvent, useConversation, useUltimate } from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { TaskChip, useTaskOf } from '../plan/ui.tsx'
import { useWorkspaceConversations } from '../workspaces/ui.tsx'
import type { AgentOrigin } from './message-types.ts'
import { openAgentSource } from './ui.tsx'

type Destination = { conversation: number; entry?: number }

export function AgentMessages() {
  const { id, entries, loading } = useConversation()
  const { switchConversation } = useUltimate()
  const [navigation, setNavigation] = useState<{ target?: Destination; back?: Destination }>({})
  const { target, back } = navigation
  useEvent('subagents:source', (value) => setNavigation(value as typeof navigation))
  useEffect(() => {
    if (!target || target.conversation !== id || loading) return
    if (target.entry === undefined) {
      setNavigation((value) => ({ ...value, target: undefined }))
      return
    }
    events.emit('ultimate:reveal-entry', { conversationId: id, entryId: target.entry })
    setNavigation((value) => ({ ...value, target: undefined }))
  }, [id, entries, loading, target])
  if (!back || back.conversation === id) return null
  return (
    <button
      className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => {
        const destination = back
        setNavigation({ target: destination })
        switchConversation(destination.conversation)
      }}
    >
      <ArrowLeftIcon className="size-3" />
      return #{back.conversation}
    </button>
  )
}

/** Who sent a message: a subagent by its agent name, a top-level coordinator by its feature. */
function Sender({ origin, label }: { origin: AgentOrigin; label?: string }) {
  const agent = label ?? (origin.kind === 'report' ? origin.agent : undefined)
  return agent ? `${agent} #${origin.sender}` : <ConversationRef id={origin.sender} />
}

export function AgentInput({ entry }: { entry: EntryRecord }) {
  const [expanded, setExpanded] = useState(false)
  const origin = entry.data as AgentOrigin
  const id = useConversation((conversation) => conversation.id)
  const { switchConversation } = useUltimate()
  const conversations = useWorkspaceConversations()
  const task = useTaskOf(origin?.sender)
  const sender = conversations.find((conversation) => conversation.id === origin.sender)
  const body = origin.body
  return (
    <section
      data-agent-origin={origin.kind}
      className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <BotIcon className="size-3.5 text-brand" />
        <span className="min-w-0 text-foreground">
          <Sender origin={origin} label={sender?.label} />
        </span>
        {task && <TaskChip task={task} />}
        <span>{origin.kind === 'instruction' ? 'instruction' : 'report'}</span>
        <button
          disabled={!sender}
          title={
            sender
              ? `Open source conversation #${origin.sender}`
              : 'Source conversation unavailable'
          }
          className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground disabled:cursor-default disabled:opacity-50"
          onClick={() =>
            id &&
            openAgentSource(
              switchConversation,
              { conversation: origin.sender, entry: origin.entry },
              { conversation: id, entry: entry.id },
            )
          }
        >
          <SquareArrowOutUpRightIcon className="size-3" />
          {sender ? 'source' : 'source unavailable'}
        </button>
      </header>
      <div
        className={`min-w-0 overflow-auto px-3 py-3 font-sans text-[13px] leading-relaxed ${expanded ? '' : 'max-h-96'}`}
      >
        <MessageResponse>{body}</MessageResponse>
      </div>
      {body.length > 1800 && (
        <button
          className="w-full cursor-pointer border-t border-border/60 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Compact view' : 'Expand full message'}
        </button>
      )}
    </section>
  )
}

export function AgentInbox({
  item,
  core,
  cancel,
}: {
  item: InboxItem
  core: ReactNode
  cancel: ReactNode
}) {
  const { id } = useConversation()
  const { switchConversation } = useUltimate()
  const conversations = useWorkspaceConversations()
  if (
    item.mode === 'write' ||
    !['subagents.instruction', 'subagents.report'].includes(item.entry?.kind ?? '')
  )
    return core
  const origin = item.entry!.data as AgentOrigin
  const sender = conversations.find((conversation) => conversation.id === origin.sender)
  const body = origin.body
  return (
    <section
      data-agent-inbox={origin.kind}
      className="flex min-w-0 items-center gap-2 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20 px-2 py-1 text-muted-foreground"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px]">
          <BotIcon className="size-3 shrink-0 text-brand" />
          <span
            className="min-w-0 truncate text-foreground"
            title={`${sender?.label ?? (origin.kind === 'report' ? origin.agent : 'agent')} #${origin.sender}`}
          >
            <Sender origin={origin} label={sender?.label} />
          </span>
          <span>{origin.kind}</span>
          <span className={item.mode === 'steer' ? 'text-brand' : ''}>
            {item.mode === 'steer' ? 'steer' : 'follow-up'}
          </span>
        </div>
        <p className="truncate text-[12px]" title={body}>
          {body}
        </p>
      </div>
      <button
        type="button"
        disabled={!sender}
        title={
          sender ? `Open source conversation #${origin.sender}` : 'Source conversation unavailable'
        }
        className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] hover:text-foreground disabled:cursor-default disabled:opacity-50"
        onClick={() =>
          id &&
          openAgentSource(
            switchConversation,
            { conversation: origin.sender, entry: origin.entry },
            { conversation: id },
          )
        }
      >
        <SquareArrowOutUpRightIcon className="size-3" />
        {sender ? 'source' : 'unavailable'}
      </button>
      {cancel}
    </section>
  )
}
