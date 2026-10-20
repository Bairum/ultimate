/**
 * Board: messages between conversations and the user, delivered as inputs or notes. Other extensions send one-way
 * messages and answer the user's open questions here.
 */
import type { Context } from '@earendil-works/chord'
import { defineDoc } from '@earendil-works/pi-durable'
import type { EntryId } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Device } from '../../shared/events.ts'
import { BoardDoc } from './refs.ts'
import type { Triage } from './refs.ts'

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
  entry?: EntryId
  answer?: EntryId
  error?: string
  /** The tool call that sent it: `message`'s or `branch`'s own id, `<script>/<n>` for a nested codemode call. */
  call?: string
  /** Images forwarded with it: the sender's entry that holds them, attached to the recipient's input on delivery. */
  images?: { entry: EntryId; count: number }
  /** Whether a message to the primary agent woke it: assessing, then act or fyi with a one-line reason. */
  triage?: Triage
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
  /**
   * Reply `text` from the user to open Board message `messageId`, from browser `device`; returns the reply's message
   * id. Records a `user.input` event.
   */
  answer(messageId: number, text: string, ctx: Context, device?: Device): Promise<number>
  /** Close open Board message `messageId` unanswered; its sender gets a one-way note. Returns the note's message id. */
  dismiss(messageId: number, ctx: Context, device?: Device): Promise<number>
  /** Send a one-way message from conversation `from` to `to` (`#id`, `@name` or `user`), once per `requestId`. */
  send(
    from: number,
    input: { to: string; text: string; reply: false },
    requestId: string,
    ctx: Context,
  ): Promise<number>
}
export { Asked, MessageSent, Triaged } from './refs.ts'
/** Messages between conversations; core, so `need` it. */
export const BoardApi = defineApi<BoardService>()('board')

/** What gates the model calls Board makes inside its tasks; an optional extension (pause) fills it. */
export type GateService = {
  /**
   * Run `work`, a model call of task `task` in conversation `conversationId` described by `what`: start it only once
   * nothing holds such work (it waits meanwhile, until `signal` aborts), and count it as in flight while it runs.
   */
  work<T>(
    call: { task: number; conversationId: number; what: string },
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>
}
/** Board's gate for in-task model calls, an extension point; `want` it: without a provider, work runs at once. */
export const Gate = defineApi<GateService>()('board.gate')
export const tier = 'core'
