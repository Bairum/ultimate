import type { EntryRecord } from '@earendil-works/pi-durable'
import { ArrowLeftIcon, BotIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { events, useAction, useConversation, useUltimate } from '@/sdk'
import { useWorkspaceConversations } from '../workspaces/data.tsx'
import type { AgentOrigin } from './message-types.ts'

let origins: Record<string, AgentOrigin> = {}
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
let target: { conversation: number; entry?: number } | undefined
let back: { conversation: number; entry?: number } | undefined
const notify = () => {
  for (const listener of listeners) listener()
}

export function openAgentSource(
  switchConversation: (id: number) => void,
  source: { conversation: number; entry?: number },
  receiver: { conversation: number; entry?: number },
) {
  back = receiver
  target = source
  switchConversation(source.conversation)
  notify()
}

/** One query per transcript revision, shared by all input renderers. */
export function AgentMessages() {
  const { id, entries, loading } = useConversation()
  const { switchConversation } = useUltimate()
  const [, refresh] = useState(0)
  useEffect(() => subscribe(() => refresh((value) => value + 1)), [])
  const ids = entries.filter((entry) => entry.kind === 'pi.user').map((entry) => entry.id)
  const { data } = useAction<Record<string, AgentOrigin>>(
    'subagents',
    'provenance',
    { entries: ids, conversation: id ?? null },
    { enabled: !!id && ids.length > 0 },
  )
  useEffect(() => {
    if (data) {
      origins = data
      notify()
    }
  }, [data, id])
  useEffect(() => {
    if (!target || target.conversation !== id || loading) return
    if (target.entry === undefined) {
      target = undefined
      return
    }
    events.emit('ultimate:reveal-entry', { conversationId: id, entryId: target.entry })
    target = undefined
  }, [id, entries, loading])
  if (!back || back.conversation === id) return null
  return (
    <button
      className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => {
        const destination = back!
        target = destination
        back = undefined
        switchConversation(destination.conversation)
        notify()
      }}
    >
      <ArrowLeftIcon className="size-3" />
      return #{back.conversation}
    </button>
  )
}

export function AgentInput({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const map = useSyncExternalStore(subscribe, () => origins)
  const origin = map[entry.id]
  const { id } = useConversation()
  const { switchConversation } = useUltimate()
  const conversations = useWorkspaceConversations()
  if (!origin) return core
  const sender = conversations.find((conversation) => conversation.id === origin.sender)
  const message = entry.model?.[0]
  const content = message?.role === 'user' ? message.content : ''
  let body =
    typeof content === 'string'
      ? content
      : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  // Only remove transport framing after durable attribution, never to decide who sent a message.
  if (origin.kind === 'report') {
    body = body.replace(new RegExp(`^\\[subagent ${origin.sender} \\([^\\n]*\\) answered\\] `), '')
    const failure = `[subagent ${origin.sender} failed: `
    if (body.startsWith(failure) && body.endsWith(']'))
      body = `Failed: ${body.slice(failure.length, -1)}`
  }
  return (
    <section
      data-agent-origin={origin.kind}
      className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <BotIcon className="size-3.5 text-brand" />
        <span className="text-foreground">
          {sender?.label ?? 'agent'} #{origin.sender}
        </span>
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
