import type { BoardData, BoardMessage } from './refs.ts'

/** Only incoming requests belong to an answer, never the outgoing reply log item. */
export function answeredMessages(messages: BoardMessage[], conversation: number, entry: number) {
  return messages.filter((message) => message.to === conversation && message.answer === entry)
}

export const emptyBoard: BoardData = { messages: [], next: 1 }
/** What waits on the user: each question to the user they have neither answered nor dismissed. */
export const waitingOnUser = (board: BoardData) =>
  board.messages.filter(
    (message) => message.to === 'user' && message.reply && message.state === 'delivered',
  ).length

/**
 * Where a conversation stands, the one state every view shows:
 * - `paused`: the host is paused and its run is parked: no task of it executes until Play;
 * - `working`: it runs, or has input queued;
 * - `waits`: the primary agent (@ultimate, @sync in the machine home) has a question open with the user, the only
 *   state that asks the user to act;
 * - `awaiting`: a conversation that is no subagent asked the primary agent (a branch asking @ultimate) and waits for
 *   the answer; a subagent's questions go to its parent, which answers them in its own run;
 * - `done`: a subagent answered, and its answer went to its parent;
 * - `failed`: its latest input ended without an answer;
 * - `idle`: everything else.
 */
export type ConversationState =
  | 'paused'
  | 'working'
  | 'waits'
  | 'awaiting'
  | 'done'
  | 'failed'
  | 'idle'

export function conversationState(
  conversation: {
    id: number
    /** `primary`: the agent that talks to the user; `subagent`: owned by a task of its parent. */
    kind: 'primary' | 'subagent' | 'other'
    runState?: 'working' | 'queued' | 'idle' | 'answered' | 'error'
    busy?: boolean
    /** A pause of the host parked its run (the `ParkedRuns` point). */
    parked?: boolean
    /** The primary agent's conversation, which a branch's open question waits on. */
    primary?: number
  },
  board: BoardData,
): ConversationState {
  const { id, kind, runState } = conversation
  if (conversation.parked) return 'paused'
  if (conversation.busy || runState === 'working' || runState === 'queued') return 'working'
  if (kind === 'primary' && waitingOnUser(board) > 0) return 'waits'
  if (
    kind !== 'subagent' &&
    board.messages.some(
      (message) => message.from === id && message.to === conversation.primary && isOpen(message),
    )
  )
    return 'awaiting'
  if (runState === 'error') return 'failed'
  if (kind === 'subagent' && runState === 'answered') return 'done'
  return 'idle'
}

/** A state in the sidebar's and System's lower-case words; `waiting` counts what waits on you. */
export function stateWord(state: ConversationState, waiting = 0) {
  if (state === 'waits') return waiting > 0 ? `${waiting} waiting on you` : 'waits on you'
  return state === 'awaiting' ? 'awaiting @ultimate' : state
}

/** The text colour each state is said in; working's comes from its phase, idle is quiet. */
export const stateTone: Partial<Record<ConversationState, string>> = {
  paused: 'text-warning',
  working: 'text-brand',
  waits: 'text-amber-700 dark:text-amber-300',
  awaiting: 'text-amber-700/80 dark:text-amber-300/70',
  done: 'text-success',
  failed: 'text-error',
}

type Conversation = {
  label?: string
  title?: string
  parentConversationId?: number
  ownerTaskId?: number
}
/**
 * The primary standing agent's conversation, which reads as a chat with the user: @ultimate's, or @sync's, which is
 * resident only in the machine home.
 */
export const ultimateChat = (conversation: Conversation) =>
  conversation.label === 'agent' &&
  (conversation.title === '@ultimate' || conversation.title === '@sync') &&
  conversation.parentConversationId === undefined &&
  conversation.ownerTaskId === undefined

/**
 * The messages to you that tool call `call` sent, itself or through a script's nested calls, in the order sent (the log
 * keeps id order). Messages from before the log recorded calls match nothing.
 */
export const sentBy = (messages: readonly BoardMessage[], call: string) =>
  messages.filter(
    (message) =>
      message.to === 'user' &&
      message.call !== undefined &&
      (message.call === call || message.call.startsWith(`${call}/`)),
  )

/** Whether a `codemode` call messaged you, from the log alone: a script interrupted before its result counts too. */
export const scriptMessaged = (
  call: { id: string; name: string },
  board: Readonly<BoardData> | null | undefined,
) => call.name === 'codemode' && sentBy(board?.messages ?? [], call.id).length > 0

/** A reply-enabled message still waiting for its answer. */
export const isOpen = (message: BoardMessage) =>
  message.reply && (message.state === 'sent' || message.state === 'delivered')

/** Who waits on whom for one message; `yours` is an open question to the user. */
export function messageStatus(message: BoardMessage) {
  if (message.state === 'failed') return 'failed'
  if (message.state === 'answered') return 'answered'
  if (message.state === 'dismissed') return 'dismissed'
  if (isOpen(message)) return message.to === 'user' ? 'yours' : 'waiting'
  if (message.state === 'sent') return 'sending'
  return message.re === undefined ? 'one-way' : 'reply'
}

/**
 * A message in its sender's chat: its status while the log holds it, `sending` while the call runs, and nothing once the
 * call is done and the bounded log has dropped it.
 */
export const sentStatus = (message: BoardMessage | undefined, running: boolean) =>
  message ? messageStatus(message) : running ? 'sending' : undefined

/** Where an outgoing message stands, in the sender's words; nothing once the log has dropped a sent one. */
export function outgoingState(
  message: BoardMessage | undefined,
  toUser: boolean,
  running: boolean,
) {
  if (!message) return running ? 'sending' : undefined
  if (message.state === 'failed') return 'failed'
  if (message.state === 'answered') return 'answered'
  if (message.state === 'dismissed') return 'dismissed'
  if (message.state === 'sent') return 'sending'
  if (!message.reply) return 'delivered'
  return toUser ? 'awaiting your reply' : 'awaiting reply'
}

export function relativeTime(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`
}
