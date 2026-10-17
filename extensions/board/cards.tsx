import type { EntryRecord } from '@earendil-works/pi-durable'
import { ArrowRightIcon, GitMergeIcon, MailIcon, SquareArrowOutUpRightIcon } from 'lucide-react'
import { useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { events, useConversation, useDocOf, useNow, useUltimate } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { openAgentSource } from '../subagents/messages.tsx'
import { useWorkspaceIndex } from '../workspaces/data.tsx'
import { relativeTime } from './data.tsx'
import type { BoardMessage, Participant } from './data.tsx'

export function BoardRoster({
  participants,
  selected,
  unread,
  onSelect,
  onMention,
}: {
  participants: Participant[]
  selected?: string
  unread: number
  onSelect: (participant: Participant) => void
  onMention: (address: string) => void
}) {
  const { switchConversation, showSurface } = useUltimate()
  const now = useNow(60000)
  return (
    <nav aria-label="Board participants" className="border-b border-border bg-muted/10">
      <div className="mx-auto flex max-w-[70rem] gap-2 overflow-x-auto px-3 py-3 sm:px-6">
        {participants.map((participant) => (
          <div
            key={participant.key}
            className={`w-40 shrink-0 rounded-md border font-mono text-[11px] ${selected === participant.key ? 'border-brand/60 bg-brand/5' : 'border-border bg-muted/20'}`}
          >
            <button
              aria-pressed={selected === participant.key}
              onClick={() => onSelect(participant)}
              className="flex w-full cursor-pointer items-center gap-2 px-2.5 pt-2.5 text-left"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${participant.status === 'working' ? 'animate-pulse bg-brand' : participant.status === 'waiting' || participant.status === 'needs input' ? 'bg-amber-400' : 'bg-muted-foreground/50'}`}
              />
              <span className="min-w-0 flex-1 truncate text-foreground" title={participant.name}>
                {typeof participant.id === 'number' && participant.address?.startsWith('#') ? (
                  <ConversationRef
                    id={participant.id}
                    title={participant.name}
                    className="flex w-full"
                  />
                ) : (
                  participant.name
                )}
              </span>
              {participant.id === 'user' && unread > 0 && (
                <span className="ml-auto text-brand">{unread}</span>
              )}
            </button>
            <div className="flex items-center gap-2 px-2.5 pt-1 pb-2 text-[10px] text-muted-foreground">
              <span>
                {participant.status === 'waiting' ? 'awaiting reply' : participant.status}
              </span>
              {participant.at !== undefined && (
                <time className="ml-auto" title={new Date(participant.at).toLocaleString()}>
                  {relativeTime(participant.at, now)}
                </time>
              )}
            </div>
            {participant.address && (
              <div className="flex items-center gap-3 border-t border-border/60 px-2.5 py-1.5 text-muted-foreground">
                {typeof participant.id === 'number' && (
                  <button
                    className="cursor-pointer hover:text-foreground"
                    onClick={() => {
                      switchConversation(participant.id as number)
                      showSurface('agent')
                    }}
                  >
                    Open
                  </button>
                )}
                <button
                  className="ml-auto cursor-pointer hover:text-foreground"
                  onClick={() => onMention(participant.address!)}
                >
                  Mention
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </nav>
  )
}

export function Address({ id }: { id: number | 'user' }) {
  const standing = useDocOf<Record<string, number>>(1, 'ultimate.standing-agents')
  const workspaces = useWorkspaceIndex()
  if (id === 'user') return <span>you</span>
  const name = Object.entries(standing ?? {}).find(([, value]) => value === id)?.[0]
  if (name) return <span>@{name}</span>
  if (Object.values(workspaces.landerConversations).includes(id)) return <span>@lander</span>
  return <ConversationRef id={id} />
}

function Body({ text, compact = false }: { text: string; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div
        className={`min-w-0 overflow-auto px-3 py-3 text-[13px] leading-relaxed ${expanded ? '' : compact ? 'max-h-40' : 'max-h-64'}`}
      >
        <MessageResponse>{text}</MessageResponse>
      </div>
      {text.length > 700 && (
        <button
          className="w-full cursor-pointer border-t border-border/60 px-3 py-1.5 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Compact view' : 'Expand full message'}
        </button>
      )}
    </>
  )
}

export function BoardCard({
  message,
  quote,
  onReply,
}: {
  message: BoardMessage
  quote?: string
  onReply: () => void
}) {
  const { switchConversation, showSurface } = useUltimate()
  const now = useNow(60000)
  const isAnswer = message.re !== undefined && message.answer !== undefined
  const destination = isAnswer ? message.from : message.to === 'user' ? message.from : message.to
  const entry = isAnswer || message.to === 'user' ? message.answer : message.entry
  return (
    <section
      data-board-message={message.id}
      className="min-w-0 rounded-md border border-border bg-muted/20"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {message.kind === 'landing' ? (
          <GitMergeIcon className="size-3.5 text-brand" />
        ) : (
          <MailIcon className="size-3.5 text-brand" />
        )}
        <span className="text-foreground">
          <Address id={message.from} />
        </span>
        <ArrowRightIcon className="size-3 shrink-0" />
        <span className="text-foreground">
          <Address id={message.to} />
        </span>
        <time
          className="ml-auto"
          dateTime={new Date(message.at).toISOString()}
          title={new Date(message.at).toLocaleString()}
        >
          {relativeTime(message.at, now)}
        </time>
      </header>
      {message.re !== undefined && (
        <div
          className="mx-3 mt-2 truncate border-l-2 border-border pl-2 text-[12px] text-muted-foreground"
          title={quote}
        >
          ↳ {quote ?? `Message ${message.re}`}
        </div>
      )}
      <Body text={message.text} compact={message.kind === 'landing'} />
      <footer className="flex flex-wrap items-center gap-3 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span className={message.state === 'failed' ? 'text-destructive' : ''}>
          {message.state === 'sent' ? 'sending' : message.state}
        </span>
        {message.error && (
          <span className="min-w-0 break-words text-destructive">{message.error}</span>
        )}
        <span className="ml-auto" />
        {destination !== 'user' && entry !== undefined && (
          <button
            className="flex cursor-pointer items-center gap-1 hover:text-foreground"
            onClick={() => {
              events.emit('board:open', { conversation: destination, entry })
              showSurface('agent')
              switchConversation(destination)
            }}
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            Open
          </button>
        )}
        {message.to === 'user' && message.from !== 'user' && (
          <button className="cursor-pointer hover:text-foreground" onClick={onReply}>
            Reply
          </button>
        )}
      </footer>
    </section>
  )
}

export function BoardInput({ entry }: { entry: EntryRecord }) {
  const origin = entry.data as { id: number; from: number | 'user'; text: string; failed?: boolean }
  const receiver = useConversation((conversation) => conversation.id)
  const { switchConversation } = useUltimate()
  const reply = entry.kind === 'board.reply'
  return (
    <section className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20">
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MailIcon className="size-3.5 text-brand" />
        <span className="text-foreground">
          <Address id={origin.from} />
        </span>
        <span>{reply ? 'Reply' : 'Message'}</span>
        {origin.failed && <span className="text-destructive">failed</span>}
        {typeof origin.from === 'number' && (
          <button
            className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
            onClick={() =>
              receiver &&
              typeof origin.from === 'number' &&
              openAgentSource(
                switchConversation,
                { conversation: origin.from },
                { conversation: receiver },
              )
            }
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            Source
          </button>
        )}
      </header>
      <Body text={origin.text} />
    </section>
  )
}
