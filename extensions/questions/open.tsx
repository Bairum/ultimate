import type { Question } from './types.ts'

/** Questions in @ultimate's latest final answer to a typed input. */
export type Reply = { conversation: number; entry: number; questions: Question[] }
/** The root's `questions.board` document: extracted questions by Board message id, and @ultimate's latest answer's. */
export type QuestionsBoard = {
  requested: number[]
  asked: Record<string, Question[]>
  reply?: Reply
}
type Doc = Readonly<QuestionsBoard> | null | undefined
/** The fields of a Board message the answer card reads. */
export type Message = {
  id: number
  from: number | 'user'
  to: number | 'user'
  reply: boolean
  state: string
}
/** The fields of a transcript entry that tell an input from the rest. */
type Entry = { id: number; kind: string; input?: boolean }

/** The questions of a Board message while it still waits on the user's reply; none once it is answered. */
export function openQuestions(board: Doc, message: Message) {
  return message.to === 'user' && message.reply && message.state === 'delivered'
    ? (board?.asked[String(message.id)] ?? [])
    : []
}

/** The newest message showing an answer card: only it takes the desktop 1–9 and Enter keys. */
export function newestAsked(board: Doc, messages: readonly Message[]) {
  return messages.findLast((message) => openQuestions(board, message).length > 0)?.id
}

/**
 * The questions of final answer `entry` in `conversation` while it is @ultimate's current answer: none once any input
 * or reset follows it in the transcript.
 */
export function replyQuestions(
  board: Doc,
  conversation: number | undefined,
  entry: number,
  transcript: readonly Entry[],
) {
  const reply = board?.reply
  if (!reply || reply.conversation !== conversation || reply.entry !== entry) return []
  return transcript.some(
    (item) =>
      item.id > entry && (item.kind === 'pi.user' || item.kind === 'pi.reset' || item.input),
  )
    ? []
    : reply.questions
}

/**
 * The card on a conversation's page that takes the desktop keys: its open final-answer card, which follows every
 * message it sent, else the card of its newest open message to the user.
 */
export function keyCard(
  board: Doc,
  conversation: number | undefined,
  messages: readonly Message[],
  transcript: readonly Entry[],
) {
  const reply = board?.reply
  if (reply && replyQuestions(board, conversation, reply.entry, transcript).length)
    return `reply:${reply.entry}`
  const id = newestAsked(
    board,
    messages.filter((message) => message.from === conversation),
  )
  return id === undefined ? undefined : `message:${id}`
}
