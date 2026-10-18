export type BoardMessage = {
  id: number
  from: number | 'user'
  to: number | 'user'
  text: string
  at: number
  reply: boolean
  re?: number
  kind?: string
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
/** Questions to the user still waiting on their answer. */
export const waitingOnUser = (board: BoardData) =>
  board.messages.filter(
    (message) => message.to === 'user' && message.reply && message.state === 'delivered',
  ).length

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

/** A reply-enabled message still waiting for its answer. */
export const isOpen = (message: BoardMessage) =>
  message.reply && (message.state === 'sent' || message.state === 'delivered')

/** Who waits on whom for one message; `yours` is an open question to the user. */
export function messageStatus(message: BoardMessage) {
  if (message.state === 'failed') return 'failed'
  if (message.state === 'answered') return 'answered'
  if (isOpen(message)) return message.to === 'user' ? 'yours' : 'waiting'
  if (message.state === 'sent') return 'sending'
  if (message.kind === 'landing') return 'landing'
  return message.re === undefined ? 'one-way' : 'reply'
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
