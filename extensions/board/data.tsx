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

export type Addresses = {
  agents: { name: string; description: string; id?: number }[]
  lander?: number
  conversations: { id: number; title?: string }[]
}
export type BoardData = { messages: BoardMessage[]; next: number; readUpTo: number }
export const emptyBoard: BoardData = { messages: [], next: 1, readUpTo: 0 }
export const unreadCount = (board: BoardData) =>
  board.messages.filter((message) => message.to === 'user' && message.id > board.readUpTo).length

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
