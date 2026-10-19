export type Question = {
  text: string
  kind: 'confirm' | 'choice'
  options?: { label: string; detail?: string; recommended?: boolean }[]
}
/** The root's `questions.board` document: extracted questions by Board message id. */
export type QuestionsBoard = {
  requested: number[]
  asked: Record<string, Question[]>
}
