import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  ArrowRightIcon,
  CheckIcon,
  GitBranchIcon,
  GitMergeIcon,
  InboxIcon,
  MailIcon,
  SendIcon,
  SquareArrowOutUpRightIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { cn, events, useConversation, useConversations, useDocOf, useNow, useUltimate } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { MessageQuestions } from '../questions/card.tsx'
import { openAgentSource } from '../subagents/messages.tsx'
import { useWorkspaceIndex } from '../workspaces/data.tsx'
import { accentIndex, messageStatus, relativeTime, side } from './data.tsx'
import type { BoardData, BoardMessage, Participant } from './data.tsx'

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
                className={`size-1.5 shrink-0 rounded-full ${participant.status === 'working' || participant.status === 'delegating' ? 'animate-pulse bg-brand' : participant.status === 'waiting' || participant.status === 'needs input' ? 'bg-amber-400' : 'bg-muted-foreground/50'}`}
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
                {participant.status === 'waiting'
                  ? 'awaiting reply'
                  : participant.status === 'delegating'
                    ? 'subagents working'
                    : participant.status}
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

/** Quiet sender accents: stripe, a faint fill and the name colour. The user always has the brand colour. */
const accents = [
  {
    left: 'border-l-sky-500/60',
    right: 'border-r-sky-500/60',
    fill: 'bg-sky-500/5',
    name: 'text-sky-700 dark:text-sky-300',
  },
  {
    left: 'border-l-emerald-500/60',
    right: 'border-r-emerald-500/60',
    fill: 'bg-emerald-500/5',
    name: 'text-emerald-700 dark:text-emerald-300',
  },
  {
    left: 'border-l-teal-500/60',
    right: 'border-r-teal-500/60',
    fill: 'bg-teal-500/5',
    name: 'text-teal-700 dark:text-teal-300',
  },
  {
    left: 'border-l-rose-500/60',
    right: 'border-r-rose-500/60',
    fill: 'bg-rose-500/5',
    name: 'text-rose-700 dark:text-rose-300',
  },
  {
    left: 'border-l-orange-500/60',
    right: 'border-r-orange-500/60',
    fill: 'bg-orange-500/5',
    name: 'text-orange-700 dark:text-orange-300',
  },
  {
    left: 'border-l-lime-500/60',
    right: 'border-r-lime-500/60',
    fill: 'bg-lime-500/5',
    name: 'text-lime-700 dark:text-lime-300',
  },
]
const userAccent = {
  left: 'border-l-brand/60',
  right: 'border-r-brand/60',
  fill: 'bg-brand/5',
  name: 'text-brand',
}
const accentOf = (id: number | 'user') =>
  id === 'user' ? userAccent : accents[accentIndex(id, accents.length)]

/** Who waits on whom, in words: an open question to the user stands out, other open requests stay amber-muted. */
function Status({ message, perspective }: { message: BoardMessage; perspective: number | 'user' }) {
  const status = messageStatus(message)
  if (status === 'yours')
    return (
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
        awaiting your reply
      </span>
    )
  if (status === 'waiting')
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1 text-amber-700/80 dark:text-amber-300/70">
        {message.from !== perspective && <Address id={message.from} />}
        waiting on <Address id={message.to} />
      </span>
    )
  if (status === 'answered')
    return (
      <span className="flex items-center gap-1">
        <CheckIcon className="size-3" />
        answered
      </span>
    )
  return <span className={status === 'failed' ? 'text-destructive' : ''}>{status}</span>
}

/**
 * One board message as a chat bubble seen from `perspective`: its own messages on the right, received ones on the
 * left, and traffic between others quieter on the left with both sides named.
 */
export function BoardCard({
  message,
  perspective,
  quote,
  onReply,
}: {
  message: BoardMessage
  perspective: number | 'user'
  quote?: string
  onReply: () => void
}) {
  const { switchConversation, showSurface } = useUltimate()
  const now = useNow(60000)
  const isAnswer = message.re !== undefined && message.answer !== undefined
  const destination = isAnswer ? message.from : message.to === 'user' ? message.from : message.to
  const entry = isAnswer || message.to === 'user' ? message.answer : message.entry
  const position = side(message, perspective)
  const accent = accentOf(message.from)
  return (
    <section
      data-board-message={message.id}
      data-side={position}
      className={cn(
        'min-w-0 rounded-md border max-sm:w-full sm:w-fit sm:min-w-[20rem]',
        position === 'right'
          ? `self-end border-r-2 border-border sm:max-w-[85%] ${accent.right} ${accent.fill}`
          : position === 'left'
            ? `self-start border-l-2 border-border sm:max-w-[85%] ${accent.left} ${accent.fill}`
            : `self-start border-l-2 border-border/60 sm:max-w-[78%] ${accent.left}`,
      )}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {message.kind === 'landing' && <GitMergeIcon className={cn('size-3.5', accent.name)} />}
        <span className={cn('flex min-w-0 font-semibold', accent.name)}>
          <Address id={message.from} />
        </span>
        {message.to !== perspective && (
          <>
            <ArrowRightIcon className="size-3 shrink-0" />
            <span className="flex min-w-0 text-foreground">
              <Address id={message.to} />
            </span>
          </>
        )}
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
        <Status message={message} perspective={perspective} />
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

/** Where an outgoing message stands, in the sender's words. */
function outgoingState(message: BoardMessage | undefined, toUser: boolean, sending: boolean) {
  if (!message) return sending ? 'sending' : undefined
  if (message.state === 'failed') return 'failed'
  if (message.state === 'answered') return 'answered'
  if (message.state === 'sent') return 'sending'
  if (toUser) return message.reply ? 'awaiting your reply' : 'in your inbox'
  return message.reply ? 'awaiting reply' : 'delivered'
}

/** The `message` tool as the message it sent; a failed call keeps the generic card with its error. */
export function MessageCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const board = useDocOf<BoardData>(1, 'board')
  const { switchConversation, showSurface } = useUltimate()
  if (call.status === 'error' || call.status === 'interrupted') return core
  const sent = /^Message (\d+) sent\.$/.exec(call.output)
  const message = sent ? board?.messages.find((m) => m.id === Number(sent[1])) : undefined
  const { to, text, reply, steer } = call.args as {
    to?: string
    text?: string
    reply?: boolean
    steer?: boolean
  }
  const recipient = message?.to ?? (to === 'user' ? 'user' : undefined)
  const toUser = recipient === 'user'
  const state = outgoingState(message, toUser, call.status !== 'done')
  return (
    <section
      data-board-outgoing={message?.id}
      className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {toUser ? (
          <InboxIcon className="size-3.5 text-brand" />
        ) : (
          <SendIcon className="size-3.5 text-brand" />
        )}
        <span>Message to</span>
        <span className="flex min-w-0 text-foreground">
          {recipient === undefined ? (to ?? '…') : <Address id={recipient} />}
        </span>
        <span>
          {(message?.reply ?? reply ?? true) ? 'expects reply' : 'one-way'}
          {steer && ' · steer'}
        </span>
        {state && <span className={state === 'failed' ? 'text-destructive' : ''}>· {state}</span>}
        {message && toUser && (
          <button
            className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
            onClick={() => showSurface('board')}
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            Board
          </button>
        )}
        {message && typeof message.to === 'number' && message.entry !== undefined && (
          <button
            className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
            onClick={() => {
              events.emit('board:open', { conversation: message.to, entry: message.entry })
              showSurface('agent')
              switchConversation(message.to as number)
            }}
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            Open
          </button>
        )}
      </header>
      {message?.error && (
        <p className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] break-words text-destructive">
          {message.error}
        </p>
      )}
      <Body text={text ?? ''} />
      {message && <MessageQuestions message={message} />}
    </section>
  )
}

/** The `branch` tool as the branch it started and the prompt it was given; a failed call keeps the generic card. */
export function BranchCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const board = useDocOf<BoardData>(1, 'board')
  const conversations = useConversations()
  const { switchConversation, showSurface } = useUltimate()
  if (call.status === 'error' || call.status === 'interrupted') return core
  const started = /^Branch #(\d+) started; message (\d+) sent\.$/.exec(call.output)
  const id = started ? Number(started[1]) : undefined
  const message = started ? board?.messages.find((m) => m.id === Number(started[2])) : undefined
  const { prompt, root, isolated } = call.args as {
    prompt?: string
    root?: number
    isolated?: boolean
  }
  const state =
    id === undefined
      ? 'starting'
      : message?.state === 'failed'
        ? 'failed'
        : message?.state === 'answered'
          ? 'reported back'
          : 'working'
  return (
    <section
      data-board-branch={id}
      className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
        <GitBranchIcon className="size-3.5 shrink-0 text-brand" />
        <span className="shrink-0">
          <span className="max-sm:hidden">Started branch</span>
          <span className="sm:hidden">Branch</span>
        </span>
        {id !== undefined && (
          <span className="flex min-w-0 overflow-hidden text-foreground">
            <ConversationRef
              className="w-full"
              id={id}
              title={conversations.find((conversation) => conversation.id === id)?.title}
            />
          </span>
        )}
        <span className="shrink-0 max-sm:hidden">
          {root !== undefined && `from #${root} · `}
          {(isolated ?? true) ? 'isolated' : 'shared'}
        </span>
        <span className={`shrink-0 ${state === 'failed' ? 'text-destructive' : ''}`}>
          · {state}
        </span>
        {id !== undefined && (
          <button
            className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 hover:text-foreground"
            onClick={() => {
              if (message?.entry !== undefined)
                events.emit('board:open', { conversation: id, entry: message.entry })
              showSurface('agent')
              switchConversation(id)
            }}
          >
            <SquareArrowOutUpRightIcon className="size-3" />
            Open
          </button>
        )}
      </header>
      {message?.error && (
        <p className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] break-words text-destructive">
          {message.error}
        </p>
      )}
      <Body text={prompt ?? ''} />
    </section>
  )
}

export function BoardInput({ entry }: { entry: EntryRecord }) {
  const origin = entry.data as {
    id: number
    from: number | 'user'
    text: string
    reply: boolean
    delivery?: 'steer' | 'followUp' | 'note'
    failed?: boolean
  }
  const receiver = useConversation((conversation) => conversation.id)
  const { switchConversation } = useUltimate()
  const reply = entry.kind === 'board.reply'
  return (
    <section className="min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20">
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MailIcon className="size-3.5 text-brand" />
        <span className="flex min-w-0 text-foreground">
          <Address id={origin.from} />
        </span>
        <span>{reply ? 'Reply' : 'Message'}</span>
        {!reply && (
          <span>
            {origin.reply ? 'expects reply' : 'one-way'}
            {origin.delivery &&
              ` · ${{ steer: 'steered', followUp: 'follow-up', note: 'note' }[origin.delivery]}`}
          </span>
        )}
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
