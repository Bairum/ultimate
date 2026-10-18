/**
 * Board: messages between conversations and the user, delivered as inputs or notes. Other extensions send one-way
 * messages and answer the user's open questions here.
 */
import type { Context } from '@earendil-works/chord'
import { defineDoc } from '@earendil-works/pi-durable'
import type { EntryId } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import { BoardDoc } from './refs.ts'

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
  entry?: EntryId
  answer?: EntryId
  error?: string
  /** The tool call that sent it: `message`'s or `branch`'s own id, `<script>/<n>` for a nested codemode call. */
  call?: string
}
/** Every message between conversations and the user, on the root conversation. */
export const Board = defineDoc<{ messages: BoardMessage[]; next: number }>({
  kind: BoardDoc.kind,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ messages: [], next: 1 }),
})

export type BoardService = {
  /** Reply `text` from the user to open Board message `messageId`; returns the reply's message id. */
  answer(messageId: number, text: string, ctx: Context): Promise<number>
  /** Send a one-way message from conversation `from` to `to` (`#id`, `@name` or `user`), once per `requestId`. */
  send(
    from: number,
    input: { to: string; text: string; reply: false },
    requestId: string,
    ctx: Context,
  ): Promise<number>
}
/**
 * Conversation `from` asked the user something: it posted reply-enabled Board message `message` to the user. Emitted in
 * the posting commit; react to it to work on the question (questions extracts its answer card).
 */
export const Asked = defineEvent<{ message: number; from: number }>('board.asked')
/** Messages between conversations; core, so `need` it. */
export const BoardApi = defineApi<BoardService>()('board')
export const tier = 'core'
