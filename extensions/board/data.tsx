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
/** @ultimate's standing conversation, which reads as a chat with the user. */
export const ultimateChat = (conversation: Conversation) =>
  conversation.label === 'agent' &&
  conversation.title === '@ultimate' &&
  conversation.parentConversationId === undefined &&
  conversation.ownerTaskId === undefined

/** The texts a `codemode` script sent you with nested `message` calls, from its result's details. */
export function scriptMessages(details: unknown): string[] {
  const calls = (details as { calls?: unknown } | undefined)?.calls
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call: { name?: unknown; status?: unknown; args?: unknown }) => {
    const args = call.args as { to?: unknown; text?: unknown } | undefined
    return call.name === 'message' &&
      call.status === 'ok' &&
      args?.to === 'user' &&
      typeof args.text === 'string'
      ? [args.text]
      : []
  })
}

/** The log message a script's call sent: the newest from `from` to you with this text, sent by `at` when known. */
export const scriptMessage = (
  messages: readonly BoardMessage[],
  from: number,
  text: string,
  at?: number,
) =>
  messages.findLast(
    (message) =>
      message.from === from &&
      message.to === 'user' &&
      message.text === text &&
      (at === undefined || message.at <= at),
  )

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
