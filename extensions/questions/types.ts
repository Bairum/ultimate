export type Question = {
  text: string
  kind: 'confirm' | 'choice'
  options?: { label: string; detail?: string; recommended?: boolean }[]
}
/** Questions in @ultimate's latest final answer to a typed input. */
export type Reply = { conversation: number; entry: number; questions: Question[] }
/** The root's `questions.board` document: extracted questions by Board message id, and @ultimate's latest answer's. */
export type QuestionsBoard = {
  requested: number[]
  asked: Record<string, Question[]>
  reply?: Reply
}
export type Asked = { answerId: number; questions: Question[] }
export type Answers = {
  askedId: number
  answers: { question: string; answer: string }[]
  note?: string
}
