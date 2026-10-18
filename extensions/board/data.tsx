export type BoardMessage = {
  id: number
  from: number | 'user'
  to: number | 'user'
  text: string
  at: number
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'failed'
  entry?: number
  answer?: number
  error?: string
  /** The tool call that sent it: `message`'s own id, or `<script>/<n>` for a nested codemode call. */
  call?: string
}

/** Only incoming requests belong to an answer, never the outgoing reply log item. */
export function answeredMessages(messages: BoardMessage[], conversation: number, entry: number) {
  return messages.filter((message) => message.to === conversation && message.answer === entry)
}

export type BoardData = { messages: BoardMessage[]; next: number }
export const emptyBoard: BoardData = { messages: [], next: 1 }
/**
 * What waits on the user's answer: each open question message to the user, and @ultimate's current final answer when
 * it asks (`reply` in the root's `questions.board` document) as one more.
 */
export const waitingOnUser = (board: BoardData, questions?: { reply?: unknown } | null) =>
  board.messages.filter(
    (message) => message.to === 'user' && message.reply && message.state === 'delivered',
  ).length + (questions?.reply ? 1 : 0)

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
