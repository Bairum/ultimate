/**
 * The Board for other extensions' browser code: its document, what waits on the user's answer, and the points where
 * an optional extension adds to a message (its answer card) or to what waits on the user.
 */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'
import type { BoardMessage } from './refs.ts'

export { emptyBoard, isOpen, waitingOnUser } from './data.tsx'
export { BoardDoc } from './refs.ts'

/** What shows under a Board message to the user (`questions` provides its answer card). */
export const MessageAnswers = definePoint<BoardMessage, ReactNode>('board.message-answers')
/** Whether @ultimate's current final answer asks the user something (`questions` provides it); it waits on them too. */
export const AnswerWaits = definePoint<null, boolean>('board.answer-waits')
