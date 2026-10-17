import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  cn,
  events,
  useChat,
  useConversation,
  useConversations,
  useDocOf,
  useNow,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { openAgentSource } from '../subagents/messages.tsx'
import { useWorkspaceIndex } from '../workspaces/data.tsx'
import { accentOf } from './accent.tsx'
import { answeredMessages, emptyBoard, messageStatus, relativeTime, side } from './data.tsx'
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

/**
 * A message to you in a chat: a bubble on the left in the sender's accent, its text, and whether it waits on you.
 * `children` mount beneath the text; that is where the answer card of a question goes.
 */
export function ChatBubble({
  from,
  message,
  text,
  children,
}: {
  from: number
  message: BoardMessage | undefined
  text: string
  children?: ReactNode
}) {
  const now = useNow(60000)
  const accent = accentOf(from)
  return (
    <section
      data-board-outgoing={message?.id}
      data-chat-bubble
      className={cn(
        'min-w-0 rounded-md border border-l-2 border-border max-sm:w-full sm:w-fit sm:max-w-[85%] sm:min-w-[20rem]',
        accent.left,
        accent.fill,
      )}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <span className={cn('flex min-w-0 font-semibold', accent.name)}>
          <Address id={from} />
        </span>
        {message && (
          <time
            className="ml-auto"
            dateTime={new Date(message.at).toISOString()}
            title={new Date(message.at).toLocaleString()}
          >
            {relativeTime(message.at, now)}
          </time>
        )}
      </header>
      <Body text={text} />
      {children}
      <footer className="flex flex-wrap items-center gap-3 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        {message ? <Status message={message} perspective="user" /> : <span>sending</span>}
        {message?.error && (
          <span className="min-w-0 break-words text-destructive">{message.error}</span>
        )}
      </footer>
    </section>
  )
}

/**
 * The `message` tool as the message it sent; a failed call keeps the generic card with its error. In a chat, a message
 * to you is a bubble.
 */
export function MessageCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const board = useDocOf<BoardData>(1, 'board')
  const { switchConversation, showSurface } = useUltimate()
  const chat = useChat()
  const sender = useConversation((conversation) => conversation.id)
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
  if (chat && toUser && sender !== undefined)
    return (
      <ChatBubble from={sender} message={message} text={text ?? ''}>
        {/* The answer card of a question to you mounts here, beneath the text. */}
      </ChatBubble>
    )
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
  const accent = accentOf(origin.from)
  return (
    <section
      data-board-input={origin.id}
      className={cn('min-w-0 rounded-md border border-l-2 border-border', accent.left, accent.fill)}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MailIcon className={cn('size-3.5 shrink-0', accent.name)} />
        <span className={cn('flex min-w-0 font-semibold', accent.name)}>
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

/** In a chat, an answer that went back to the conversations that asked, not to you, folds to one line. */
export function ChatAnswer({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const chat = useChat()
  const message = entry.model?.[0]
  if (!chat || message?.role !== 'assistant' || message.stopReason !== 'stop') return core
  return <ReplyFold entry={entry} core={core} />
}

function ReplyFold({ entry, core }: { entry: EntryRecord; core: ReactNode }) {
  const board = useDocOf<BoardData>(1, 'board') ?? emptyBoard
  const answered = answeredMessages(board.messages, entry.conversationId, entry.id)
  if (!answered.length || answered.some((m) => !m.reply || m.from === 'user')) return core
  return (
    <Collapsible className="group/reply">
      <CollapsibleTrigger className="flex cursor-pointer flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground">
        replied to
        {answered.map((m) => (
          <span className="flex min-w-0" key={m.id}>
            <Address id={m.from} />
          </span>
        ))}
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/reply:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">{core}</CollapsibleContent>
    </Collapsible>
  )
}
