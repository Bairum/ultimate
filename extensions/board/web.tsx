import type { EntryRecord } from '@earendil-works/pi-durable'
import { ArrowUpIcon, MessagesSquareIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Header,
  Sidebar,
  StatusLine,
  api,
  defineWebExtension,
  events,
  touchKeyboard,
  useAction,
  useConversation,
  useConversations,
  useDocOf,
  useEvent,
  useUiState,
  useUltimate,
} from '@/sdk'
import { Address, BoardCard, BoardInput, BoardRoster, BranchCall, MessageCall } from './cards.tsx'
import { useOverview } from '../conversations/feature.tsx'
import {
  emptyBoard,
  answeredMessages,
  parseAddress,
  suggestions,
  unreadCount,
  participants,
  participantMessages,
  waits,
} from './data.tsx'
import type { Addresses, BoardData } from './data.tsx'

const useBoard = () => useDocOf<BoardData>(1, 'board') ?? emptyBoard

/** One side of the open-request summary; amber while anyone is waiting. */
function Count({ value, children }: { value: number; children: ReactNode }) {
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center gap-1 ${value ? 'text-amber-700 dark:text-amber-300' : ''}`}
    >
      {children} · {value}
    </span>
  )
}

function BoardAnswerLabel({ entry }: { entry: EntryRecord }) {
  const board = useBoard()
  const conversation = useConversation((value) => value.id)
  const messages =
    conversation === undefined ? [] : answeredMessages(board.messages, conversation, entry.id)
  return messages.map((message) => (
    <span
      key={message.id}
      className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1 text-muted-foreground"
    >
      {message.reply ? '↩ sent to' : 'not sent · one-way from'} <Address id={message.from} />
    </span>
  ))
}

/** Stay mounted across surfaces so an Open click can reveal after Agent mounts and loads. */
function BoardNavigation() {
  const { id, entries, loading } = useConversation()
  const { surface } = useUltimate()
  const [target, setTarget] = useState<{ conversation: number; entry: number }>()
  useEvent('board:open', (value) => setTarget(value as NonNullable<typeof target>))
  useEffect(() => {
    if (!target || surface !== 'agent' || id !== target.conversation || loading) return undefined
    const frame = requestAnimationFrame(() => {
      events.emit('ultimate:reveal-entry', { conversationId: id, entryId: target.entry })
      setTarget(undefined)
    })
    return () => cancelAnimationFrame(frame)
  }, [surface, id, entries, loading, target])
  return null
}

/**
 * The conversations sidebar beside the Board. The Board shows no conversation, so picking a row there opens it on the
 * Agent surface; the row itself only switches the shown conversation.
 */
function BoardSidebar() {
  const { showSurface } = useUltimate()
  return (
    <div
      className="contents"
      onClick={(event) => {
        if (
          (event.target as Element).closest(
            '[data-conversation] > button:first-child, [data-child-conversation]',
          )
        )
          showSurface('agent')
      }}
    >
      <Sidebar />
    </div>
  )
}

function InboxBadge() {
  const board = useBoard()
  const { showSurface } = useUltimate()
  const [, setTab] = useUiState<'inbox' | 'all'>('board.tab', 'all')
  const count = unreadCount(board)
  if (!count) return null
  return (
    <button
      className="cursor-pointer text-brand hover:text-foreground"
      onClick={() => {
        setTab('inbox')
        showSurface('board')
      }}
    >
      inbox {count}
    </button>
  )
}

function BoardSurface() {
  const board = useBoard()
  const [tab, setTab] = useUiState<'inbox' | 'all'>('board.tab', 'all')
  const addresses = useAction<Addresses>('board', 'addresses')
  const standing = useDocOf<Record<string, number>>(1, 'ultimate.standing-agents')
  const conversations = useConversations()
  const overview = useOverview()
  const [concluded] = useUiState<number[]>('ext.conversations.concluded', [])
  const [participant, setParticipant] = useState<string>()
  const roster = participants(
    board,
    { ...(addresses.data ?? { agents: [], conversations: [] }), concluded },
    standing ?? {},
    conversations,
    new Set(
      Object.entries(overview)
        .filter(
          ([, row]) => row.assessmentStatus === 'ready' && row.assessment?.value === 'needs_input',
        )
        .map(([id]) => Number(id)),
    ),
  )
  const active = roster.find((item) => item.key === participant)
  const perspective = active?.id ?? 'user'
  const open = waits(board.messages, perspective)
  const [draft, setDraft] = useUiState<string>('board.draft', '')
  const [re, setRe] = useState<number>()
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const feed = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const following = useRef(true)
  const count = unreadCount(board)
  const messages = (
    active?.id === undefined ? board.messages : participantMessages(board.messages, active.id)
  ).filter((message) => tab === 'all' || message.to === 'user')
  const latest = messages.at(-1)?.id
  const hasUltimate = addresses.data?.agents.some((agent) => agent.name === 'ultimate') ?? false
  const choices = addresses.data ? suggestions(draft, caret, addresses.data) : []
  const choice = choices[Math.min(selected, choices.length - 1)]
  const replyTo = board.messages.find((message) => message.id === re)
  useEffect(() => {
    following.current = true
    feed.current?.scrollTo({ top: feed.current.scrollHeight })
  }, [tab, participant])
  useEffect(() => {
    if (following.current) feed.current?.scrollTo({ top: feed.current.scrollHeight })
  }, [latest, tab])
  useEffect(() => {
    if (tab !== 'inbox' || latest === undefined || latest <= board.readUpTo) return
    api
      .action('board', 'read', { upTo: latest })
      .catch((failure: Error) => setError(failure.message))
  }, [tab, latest, board.readUpTo])
  function choose(value: NonNullable<typeof choice>) {
    const next = draft.slice(0, value.start) + value.token + ' ' + draft.slice(caret)
    setDraft(next)
    const position = value.start + value.token.length + 1
    setCaret(position)
    setSelected(0)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(position, position)
    })
  }
  async function send() {
    if (busy) return
    const parsed = parseAddress(draft, hasUltimate)
    if (!parsed.to) {
      setError('Start with an @agent or #conversation address.')
      return
    }
    if (!parsed.text) {
      setError('Write a message after the address.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.action('board', 'post', { ...parsed, ...(re === undefined ? {} : { re }) })
      setDraft('')
      setCaret(0)
      setRe(undefined)
      following.current = true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <BoardSidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header>
            <div className="flex items-center gap-5 px-1 font-mono text-[12px]">
              <h1 className="text-muted-foreground">Board</h1>
              <button
                aria-pressed={tab === 'inbox'}
                className={`cursor-pointer ${tab === 'inbox' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setTab('inbox')}
              >
                Inbox{count > 0 && <span className="ml-1.5 text-brand">{count}</span>}
              </button>
              <button
                aria-pressed={tab === 'all'}
                className={`cursor-pointer ${tab === 'all' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setTab('all')}
              >
                All
              </button>
            </div>
          </Header>
          <BoardRoster
            participants={roster}
            selected={participant}
            unread={count}
            onSelect={(item) => {
              setParticipant(participant === item.key ? undefined : item.key)
              setTab('all')
            }}
            onMention={(address) => {
              setDraft(`${address} `)
              setCaret(address.length + 1)
              setRe(undefined)
              input.current?.focus()
            }}
          />
          {active && (
            <div className="mx-auto flex w-full max-w-[46rem] items-center gap-2 px-3 pt-3 pb-1 font-mono text-[11px] text-muted-foreground sm:px-6">
              {active.id === undefined ? (
                <span>Messages with {active.name}</span>
              ) : perspective === 'user' ? (
                <span className="flex flex-wrap gap-x-3">
                  <Count value={open.owes}>waiting on you</Count>
                  <Count value={open.waiting}>you wait on others</Count>
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-3">
                  <Count value={open.onUser}>
                    <Address id={perspective} /> waits on you
                  </Count>
                  <Count value={open.onIt}>
                    you wait on <Address id={perspective} />
                  </Count>
                  {open.waiting > open.onUser && (
                    <Count value={open.waiting - open.onUser}>
                      <Address id={perspective} /> waits on others
                    </Count>
                  )}
                  {open.owes > open.onIt && (
                    <Count value={open.owes - open.onIt}>
                      others wait on <Address id={perspective} />
                    </Count>
                  )}
                </span>
              )}
              <button
                aria-label="Clear participant filter"
                className="ml-auto shrink-0 cursor-pointer self-start whitespace-nowrap hover:text-foreground"
                onClick={() => setParticipant(undefined)}
              >
                Clear ×
              </button>
            </div>
          )}
          <div
            ref={feed}
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={() => {
              const el = feed.current
              if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
            }}
          >
            <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-3 px-3 pt-6 pb-6 sm:px-6">
              {!messages.length && (
                <p className="py-12 text-center text-[13px] text-muted-foreground">
                  {tab === 'inbox'
                    ? 'Your inbox is quiet.'
                    : 'Messages between you and your agents appear here.'}
                </p>
              )}
              {messages.map((message) => (
                <BoardCard
                  key={message.id}
                  message={message}
                  perspective={perspective}
                  quote={
                    board.messages.find((parent) => parent.id === message.re)?.text.split('\n')[0]
                  }
                  onReply={() => {
                    const name = Object.entries(standing ?? {}).find(
                      ([, id]) => id === message.from,
                    )?.[0]
                    const address = name
                      ? `@${name}`
                      : message.from === addresses.data?.lander
                        ? '@lander'
                        : `#${message.from}`
                    setDraft(`${address} `)
                    setRe(message.id)
                    setCaret(address.length + 1)
                    input.current?.focus()
                  }}
                />
              ))}
            </div>
          </div>
          <div className="mx-auto w-full max-w-[46rem] px-3 pt-2 pb-3 sm:px-6">
            {error && (
              <p role="alert" className="mb-2 break-words text-[12px] text-destructive">
                {error}
              </p>
            )}
            {addresses.error && (
              <p role="alert" className="mb-2 text-[12px] text-destructive">
                {addresses.error.message}
              </p>
            )}
            <div className="relative rounded-xl border border-border bg-muted/20 focus-within:border-brand/50">
              {replyTo && (
                <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[12px] text-muted-foreground">
                  <span className="truncate">Replying to: {replyTo.text}</span>
                  <button
                    aria-label="Cancel reply"
                    className="ml-auto cursor-pointer"
                    onClick={() => setRe(undefined)}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              )}
              {choices.length > 0 && (
                <div
                  role="listbox"
                  aria-label="Addresses"
                  className="absolute right-0 bottom-full left-0 mb-2 max-h-64 overflow-auto rounded-md border border-border bg-background p-1 shadow-lg"
                >
                  {choices.map((item, index) => (
                    <button
                      key={item.token}
                      role="option"
                      aria-selected={item === choice}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded px-2 py-2 text-left text-[12px] ${index === selected ? 'bg-muted' : 'hover:bg-muted'}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(item)}
                    >
                      <span className="shrink-0 font-mono text-brand">{item.token}</span>
                      <span className="truncate text-muted-foreground">{item.detail}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={input}
                aria-label="Board message"
                rows={2}
                value={draft}
                disabled={busy}
                placeholder={
                  hasUltimate
                    ? 'Message @ultimate, or start with @agent / #conversation…'
                    : 'Start with @agent or #conversation…'
                }
                className="block max-h-48 min-h-20 w-full resize-none field-sizing-content bg-transparent px-3 pt-3 pb-1 text-[14px] outline-none placeholder:text-muted-foreground/70"
                onChange={(event) => {
                  setDraft(event.target.value)
                  setCaret(event.target.selectionStart)
                  setSelected(0)
                }}
                onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (choices.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                    event.preventDefault()
                    setSelected(
                      (selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) %
                        choices.length,
                    )
                    return
                  }
                  if (
                    choice &&
                    (event.key === 'Tab' || (event.key === 'Enter' && !touchKeyboard()))
                  ) {
                    event.preventDefault()
                    choose(choice)
                    return
                  }
                  if (event.key === 'Enter' && !event.shiftKey && !touchKeyboard()) {
                    event.preventDefault()
                    void send()
                  }
                }}
              />
              <div className="flex items-center justify-between px-3 pb-2 font-mono text-[11px] text-muted-foreground">
                <span>
                  {hasUltimate ? 'to @ultimate unless addressed' : '@agent · #conversation'}
                </span>
                <button
                  aria-label="Send board message"
                  disabled={busy || !draft.trim()}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md bg-foreground/80 text-background hover:bg-foreground disabled:cursor-default disabled:opacity-30"
                  onClick={() => void send()}
                >
                  <ArrowUpIcon className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    { id: 'board', title: 'Board', icon: MessagesSquareIcon, order: -100, component: BoardSurface },
  ],
  slots: { 'statusline.right': [InboxBadge], overlay: [BoardNavigation] },
  entries: { 'board.message': BoardInput, 'board.reply': BoardInput },
  tools: { message: MessageCall, branch: BranchCall },
  answerLabels: [BoardAnswerLabel],
})
