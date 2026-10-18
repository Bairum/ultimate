/**
 * Questions in the browser: the open questions extracted from agents' messages to the user, and the actions that
 * answer them from a card. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { QuestionsBoard } from './types.ts'

/** One answered question: the question's text and the chosen or typed answer. */
export type Answer = { question: string; answer: string }

/** Extracted questions by Board message id, and those of @ultimate's latest final answer, on conversation 1. */
export const QuestionsDoc = docRef<QuestionsBoard>('questions.board')

/**
 * `{ messageId, answers }` → `{ id }`: answer the questions of open Board message `messageId` with a Board reply to its
 * sender; `id` is the reply's message id. Fails when the message no longer waits on the user.
 */
export const AnswerAction = actionRef<{ messageId: number; answers: Answer[] }, { id: number }>(
  'questions',
  'answer',
)
/**
 * `{ entryId, answers }` → `{}`: answer the questions of @ultimate's current final answer `entryId` as a typed input in
 * its conversation. One call wins; fails when the answer is no longer current or its conversation is busy.
 */
export const ReplyAction = actionRef<{ entryId: number; answers: Answer[] }, Record<string, never>>(
  'questions',
  'reply',
)
