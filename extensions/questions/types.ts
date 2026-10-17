export type Question = {
  text: string
  kind: 'confirm' | 'choice'
  options?: { label: string; detail?: string; recommended?: boolean }[]
}
export type Asked = { answerId: number; questions: Question[] }
export type Answers = {
  askedId: number
  answers: { question: string; answer: string }[]
  note?: string
}
