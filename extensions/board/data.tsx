import { subagentsBusy } from '../conversations/subtree.tsx'

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

export type Addresses = {
  agents: { name: string; description: string; id?: number }[]
  lander?: number
  concluded?: number[]
  conversations: { id: number; title?: string }[]
}
export type BoardData = { messages: BoardMessage[]; next: number; readUpTo: number }
export const emptyBoard: BoardData = { messages: [], next: 1, readUpTo: 0 }
export const unreadCount = (board: BoardData) =>
  board.messages.filter((message) => message.to === 'user' && message.id > board.readUpTo).length

export type Participant = {
  key: string
  id?: number | 'user'
  name: string
  address?: string
  status: 'working' | 'delegating' | 'waiting' | 'needs input' | 'idle'
  at?: number
}
type Conversation = {
  id: number
  title?: string
  label?: string
  parentConversationId?: number
  ownerTaskId?: number
  busy: boolean
  inputAt?: number
  answerAt?: number
}
export function participantMessages(messages: BoardMessage[], id: number | 'user') {
  return messages.filter((message) => message.from === id || message.to === id)
}

/** A reply-enabled message still waiting for its answer. */
export const isOpen = (message: BoardMessage) =>
  message.reply && (message.state === 'sent' || message.state === 'delivered')

/** Where a message sits in a chat seen from `perspective`: its own messages right, received ones left, others aside. */
export function side(message: BoardMessage, perspective: number | 'user') {
  return message.from === perspective ? 'right' : message.to === perspective ? 'left' : 'aside'
}

/** Who waits on whom for one message; `yours` is an open question to the user. */
export function messageStatus(message: BoardMessage) {
  if (message.state === 'failed') return 'failed'
  if (message.state === 'answered') return 'answered'
  if (isOpen(message)) return message.to === 'user' ? 'yours' : 'waiting'
  if (message.state === 'sent') return 'sending'
  if (message.kind === 'landing') return 'landing'
  return message.re === undefined ? 'one-way' : 'reply'
}

/** Open reply-enabled messages around `id`: sent by it (it waits) and sent to it (it owes), and those with the user. */
export function waits(messages: BoardMessage[], id: number | 'user') {
  const open = messages.filter(isOpen)
  return {
    waiting: open.filter((message) => message.from === id).length,
    owes: open.filter((message) => message.to === id).length,
    onUser: open.filter((message) => message.from === id && message.to === 'user').length,
    onIt: open.filter((message) => message.from === 'user' && message.to === id).length,
  }
}

/** A stable palette slot for a sender other than the user. */
export function accentIndex(id: number, size: number) {
  let hash = 0
  for (const char of `#${id}`) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  return (hash >>> 0) % size
}

export function participantStatus(
  id: number | 'user' | undefined,
  busy: boolean,
  messages: BoardMessage[],
  needsInput = false,
  delegating = false,
): Participant['status'] {
  if (busy) return 'working'
  if (delegating) return 'delegating'
  if (needsInput) return 'needs input'
  return id !== undefined && messages.some((message) => message.from === id && isOpen(message))
    ? 'waiting'
    : 'idle'
}
export function participants(
  board: BoardData,
  addresses: Addresses,
  standing: Record<string, number>,
  conversations: readonly Conversation[],
  needsInput: ReadonlySet<number> = new Set(),
): Participant[] {
  const result: Participant[] = []
  const seen = new Set<number | 'user'>()
  function add(key: string, name: string, id?: number | 'user', address?: string) {
    if (id !== undefined && seen.has(id)) return
    if (id !== undefined) seen.add(id)
    const conversation = conversations.find((item) => item.id === id)
    const times = [
      conversation?.inputAt,
      conversation?.answerAt,
      ...board.messages
        .filter((message) => message.from === id || message.to === id)
        .map((message) => message.at),
    ].filter((at): at is number => at !== undefined)
    result.push({
      key,
      id,
      name,
      address,
      status: participantStatus(
        id,
        conversation?.busy ?? false,
        board.messages,
        typeof id === 'number' && needsInput.has(id),
        typeof id === 'number' && subagentsBusy(conversations, id),
      ),
      at: times.length ? Math.max(...times) : undefined,
    })
  }
  add('user', 'you', 'user')
  for (const agent of addresses.agents)
    add(`@${agent.name}`, `@${agent.name}`, standing[agent.name] ?? agent.id, `@${agent.name}`)
  if (addresses.lander !== undefined) add('@lander', '@lander', addresses.lander, '@lander')
  for (const conversation of conversations) {
    if (conversation.parentConversationId || addresses.concluded?.includes(conversation.id))
      continue
    if (
      conversation.label === 'coordinator' ||
      board.messages.some(
        (message) => message.from === conversation.id || message.to === conversation.id,
      )
    )
      add(
        `#${conversation.id}`,
        conversation.title ?? 'Coordinator',
        conversation.id,
        `#${conversation.id}`,
      )
  }
  return result
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

export function parseAddress(text: string, hasUltimate: boolean) {
  const match = text.match(/^\s*(@[\w-]+|#\d+)(?:\s+|$)/)
  return {
    to: match?.[1] ?? (hasUltimate ? '@ultimate' : ''),
    text: match ? text.slice(match[0].length).trim() : text.trim(),
  }
}

export function suggestions(text: string, caret: number, addresses: Addresses) {
  const match = text.slice(0, caret).match(/(?:^|\s)([@#][\w-]*)$/)
  if (!match) return []
  const token = match[1]
  const choices = token.startsWith('@')
    ? [
        ...addresses.agents.map((agent) => ({
          token: `@${agent.name}`,
          detail: agent.description,
        })),
        ...(addresses.lander ? [{ token: '@lander', detail: 'Landing agent' }] : []),
      ]
    : addresses.conversations.map((conversation) => ({
        token: `#${conversation.id}`,
        detail: conversation.title ?? 'Conversation',
      }))
  return choices
    .filter((choice) =>
      (token.startsWith('@') ? choice.token : `${choice.token} ${choice.detail}`)
        .toLowerCase()
        .includes(token.slice(1).toLowerCase()),
    )
    .slice(0, 8)
    .map((choice) => ({ ...choice, start: caret - token.length }))
}
