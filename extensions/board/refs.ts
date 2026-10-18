/**
 * The Board in the browser: every message between conversations and the user, which the sidebar, the message cards
 * and the sounds read. Browser-safe.
 */
import { docRef } from '../../shared/extension-api.ts'

/** One Board message as the `board` document stores it. */
export type BoardMessage = {
  id: number
  from: number | 'user'
  to: number | 'user'
  text: string
  at: number
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'failed'
  entry?: number
  answer?: number
  error?: string
  /** The tool call that sent it: `message`'s own id, or `<script>/<n>` for a nested codemode call. */
  call?: string
}
export type BoardData = { messages: BoardMessage[]; next: number }

/** Every message between conversations and the user, oldest first, on conversation 1. */
export const BoardDoc = docRef<BoardData>('board')
