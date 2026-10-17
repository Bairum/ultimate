import type { Question } from './types.ts'

/** The root's `questions.board` document: extracted questions by Board message id. */
export type QuestionsBoard = { requested: number[]; asked: Record<string, Question[]> }
type Doc = Readonly<QuestionsBoard> | null | undefined
/** The fields of a Board message the answer card reads. */
export type Message = { id: number; to: number | 'user'; reply: boolean; state: string }

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
