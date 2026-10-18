/**
 * Questions: turns the open decisions in agents' messages to the user into answer cards. Board asks it to extract the
 * questions of each message it sends to the user.
 */
import type { Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { BoardMessage } from '../board/api.ts'

export type QuestionsService = {
  /** Extract the open questions of a Board message to the user in the background, once; call it in the sending `tx`. */
  request(tx: Tx, message: BoardMessage): Promise<void>
}
/** Question extraction for Board messages; `want` it, since questions may be disabled. */
export const QuestionsApi = defineApi<QuestionsService>()('questions')
