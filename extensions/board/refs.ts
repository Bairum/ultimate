/**
 * The Board in the browser: every message between conversations and the user, which the sidebar, the message cards
 * and the sounds read, and the event of a question to the user. Browser-safe.
 */
import { docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/** One Board message as the `board` document stores it. */
export type BoardMessage = {
  id: number
  from: number | 'user'
  to: number | 'user'
  text: string
  at: number
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'dismissed' | 'failed'
  entry?: number
  answer?: number
  error?: string
  /** The tool call that sent it: `message`'s own id, or `<script>/<n>` for a nested codemode call. */
  call?: string
  /** Images forwarded with it: the sender's entry that holds them, attached to the recipient's input on delivery. */
  images?: { entry: number; count: number }
  /** Whether a message to the primary agent woke it: assessing, then act or fyi with a one-line reason. */
  triage?: Triage
}
/** A triage verdict: `act` wakes the primary agent, `fyi` leaves it as context for its next input. */
export type Triage = { verdict: 'assessing' | 'act' | 'fyi'; reason?: string }
export type BoardData = { messages: BoardMessage[]; next: number }

/** Every message between conversations and the user, oldest first, on conversation 1. */
export const BoardDoc = docRef<BoardData>('board')

/**
 * Conversation `from` asked the user something: it posted reply-enabled Board message `message` to the user. Emitted in
 * the posting commit; react to it to work on the question (questions extracts its answer card).
 */
export const Asked = defineEvent<{ message: number; from: number }>('board.asked')

/**
 * Board message `message` was posted from `from` to `to`; `reply` whether it waits for an answer, `steer` whether it
 * steers a busy recipient. Never its text. Emitted in the posting commit; answers are no posts.
 */
export const MessageSent = defineEvent<{
  message: number
  from: number | 'user'
  to: number | 'user'
  reply: boolean
  steer: boolean
}>('board.sent')

/**
 * Board message `message` from `from` to the primary agent `to` was triaged: `act` woke it, `fyi` left it as context.
 * Emitted in the commit that records the verdict.
 */
export const Triaged = defineEvent<{
  message: number
  from: number
  to: number
  verdict: 'act' | 'fyi'
  reason: string
}>('board.triaged')
