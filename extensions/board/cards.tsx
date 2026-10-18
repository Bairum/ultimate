import type { ToolResultMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import {
  CheckIcon,
  ChevronRightIcon,
  GitBranchIcon,
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
  useTranscript,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { ConversationRef } from '../conversations/feature.tsx'
import { MessageQuestions } from '../questions/card.tsx'
import { openAgentSource } from '../subagents/messages.tsx'
import { useWorkspaceIndex } from '../workspaces/data.tsx'
import { accentOf } from './accent.tsx'
import {
  answeredMessages,
  emptyBoard,
  messageStatus,
  outgoingState,
  relativeTime,
  scriptMessage,
  scriptMessages,
  sentStatus,
} from './data.tsx'
import type { BoardData, BoardMessage } from './data.tsx'

export function Address({ id }: { id: number | 'user' }) {
  const standing = useDocOf<Record<string, number>>(1, 'ultimate.standing-agents')
  const workspaces = useWorkspaceIndex()
  if (id === 'user') return <span>you</span>
  const name = Object.entries(standing ?? {}).find(([, value]) => value === id)?.[0]
  if (name) return <span>@{name}</span>
  if (Object.values(workspaces.landerConversations).includes(id)) return <span>@lander</span>
  return <ConversationRef id={id} />
}

function Body({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div
        className={`min-w-0 overflow-auto px-3 py-3 text-[13px] leading-relaxed ${expanded ? '' : 'max-h-64'}`}
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
 * A message to you in a chat: a bubble on the left in the sender's accent, its text, and whether it waits on you.
 * `children` mount beneath the text; that is where the answer card of a question goes. `running` is whether the call
 * that sends it is still running.
 */
export function ChatBubble({
  from,
  message,
  text,
  running,
  children,
}: {
  from: number
  message: BoardMessage | undefined
  text: string
  running: boolean
  children?: ReactNode
}) {
  const now = useNow(60000)
  const accent = accentOf(from)
  const status = sentStatus(message, running)
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
      {status && (
        <footer className="flex flex-wrap items-center gap-3 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {message ? <Status message={message} perspective="user" /> : <span>{status}</span>}
          {message?.error && (
            <span className="min-w-0 break-words text-destructive">{message.error}</span>
          )}
        </footer>
      )}
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
      <ChatBubble
        from={sender}
        message={message}
        running={call.status !== 'done'}
        text={text ?? ''}
      >
        {message && <MessageQuestions message={message} />}
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

/**
 * In a chat, an answer that went back to the conversations that asked, not to you, folds to one line, and a `codemode`
 * script that messaged you shows each message as a bubble.
 */
export function ChatAnswer({
  entry,
  core,
  blocks,
}: {
  entry: EntryRecord
  core: ReactNode
  blocks?: readonly number[]
}) {
  const chat = useChat()
  const message = entry.model?.[0]
  if (!chat || message?.role !== 'assistant') return core
  if (message.stopReason === 'stop') return <ReplyFold entry={entry} core={core} />
  const shown = (blocks ?? message.content.map((_, index) => index)).flatMap((index) => {
    const block = message.content[index]
    return block?.type === 'toolCall' ? [block] : []
  })
  if (!shown.some((block) => block.name === 'codemode')) return core
  return <ScriptMessages core={core} entry={entry} shown={shown} />
}

/**
 * The messages to you that the shown `codemode` calls sent, as bubbles beneath a quiet line that opens the calls; the
 * calls stay open above them when the row also shows other tools.
 */
function ScriptMessages({
  entry,
  core,
  shown,
}: {
  entry: EntryRecord
  core: ReactNode
  shown: readonly { id: string; name: string }[]
}) {
  const board = useDocOf<BoardData>(1, 'board') ?? emptyBoard
  const transcript = useTranscript()
  const sent = shown.flatMap((block) => {
    if (block.name !== 'codemode') return []
    const result = transcript
      .map((item) => item.model?.[0])
      .find(
        (value): value is ToolResultMessage =>
          value?.role === 'toolResult' && value.toolCallId === block.id,
      )
    return scriptMessages(result?.details).map((text, index) => ({
      key: `${block.id}:${index}`,
      text,
      message: scriptMessage(board.messages, entry.conversationId, text, result?.timestamp),
    }))
  })
  if (!sent.length) return core
  const bubbles = sent.map(({ key, text, message }) => (
    <ChatBubble from={entry.conversationId} key={key} message={message} running={false} text={text}>
      {message && <MessageQuestions message={message} />}
    </ChatBubble>
  ))
  if (shown.some((block) => block.name !== 'codemode'))
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {core}
        {bubbles}
      </div>
    )
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Collapsible className="group/script">
        <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground">
          sent with codemode
          <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/script:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3">{core}</CollapsibleContent>
      </Collapsible>
      {bubbles}
    </div>
  )
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
