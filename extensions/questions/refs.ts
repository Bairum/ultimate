/**
 * Questions in the browser: the open questions extracted from agents' messages to the user, and the actions that
 * answer them from a card. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { QuestionsBoard } from './types.ts'

/** One answered question: the question's text and the chosen or typed answer. */
export type Answer = { question: string; answer: string }

/** Extracted questions by Board message id, on conversation 1. */
export const QuestionsDoc = docRef<QuestionsBoard>('questions.board')

/**
 * `{ messageId, answers }` or `{ messageId, text }` → `{ id }`: answer open Board message `messageId` with a Board reply
 * to its sender, from its extracted questions or as free text; `id` is the reply's message id. Fails when the message
 * no longer waits on the user.
 */
export const AnswerAction = actionRef<
  { messageId: number; answers?: Answer[]; text?: string },
  { id: number }
>('questions', 'answer')
/**
 * `{ messageId }` → `{ id }`: close open Board message `messageId` without an answer; its sender gets a one-way note,
 * `id`, that starts no run. Fails when the message no longer waits on the user.
 */
export const DismissAction = actionRef<{ messageId: number }, { id: number }>(
  'questions',
  'dismiss',
)
