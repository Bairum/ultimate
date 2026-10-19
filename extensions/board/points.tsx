import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'
import type { BoardMessage } from './refs.ts'

/** What shows under a Board message to the user (`questions` provides its answer card). */
export const MessageAnswers = definePoint<BoardMessage, ReactNode>('board.message-answers')
