/**
 * One extracted question. `ref` is the number the message gave it ("2"), and an option's `key` its letter ("a"), so an
 * answer can name them; both are absent when the message numbered nothing. An option's `preview` is Markdown shown
 * beside it (a diff, a sketch); `scale` bounds a numbered rating with its end labels; `placeholder` hints a typed answer.
 */
export type Question = {
  text: string
  kind: 'choice' | 'multi' | 'confirm' | 'text' | 'scale'
  ref?: string
  options?: {
    label: string
    detail?: string
    recommended?: boolean
    key?: string
    preview?: string
  }[]
  scale?: { min: number; max: number; low?: string; high?: string }
  placeholder?: string
}
/** The root's `questions.board` document: extracted questions by message id. */
export type MessageQuestionsData = {
  requested: number[]
  asked: Record<string, Question[]>
}
