import type { Question } from './types.ts'

/** A choice on the card: an extracted option, Yes/No for a confirmation, or the typed "Something else…". */
export type Choice = {
  label: string
  key?: string
  detail?: string
  recommended?: boolean
  custom?: true
}

/** The choices a question offers, in order, ending with "Something else…". */
export function choices(question: Question): Choice[] {
  return [
    ...(question.kind === 'confirm'
      ? [{ label: 'Yes' }, { label: 'No' }]
      : (question.options ?? [])),
    { label: 'Something else…', custom: true },
  ]
}

/** The index of the choice a key picks: 1–9 by position, or a letter by the option's own key. */
export function choiceForKey(question: Question, key: string) {
  const list = choices(question)
  if (/^[1-9]$/.test(key)) return Number(key) - 1 < list.length ? Number(key) - 1 : undefined
  const index = list.findIndex((choice) => choice.key === key)
  return index >= 0 ? index : undefined
}

/** The recommended answer of every question that has one, by question index. */
export function picks(questions: Question[]): Record<number, string> {
  return Object.fromEntries(
    questions.flatMap((question, index) => {
      const pick = question.options?.find((option) => option.recommended)
      return pick ? [[index, pick.label]] : []
    }),
  )
}

/** The answers ready to send, in question order; empty and unanswered questions stay out. */
export const answered = (questions: Question[], answers: Record<number, string>) =>
  questions.flatMap((question, index) =>
    answers[index]?.trim() ? [{ question: question.text, answer: answers[index].trim() }] : [],
  )

/** A question's position label: its own number when the message gave one, else its place on the card. */
export const position = (question: Question, index: number) => question.ref ?? String(index + 1)
