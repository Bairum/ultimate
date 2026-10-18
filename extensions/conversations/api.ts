/**
 * Conversations: titles, summaries, the summary model and concluding conversations. Other extensions read what a
 * conversation is about and ask the summary model through this service.
 */
import type { Context } from '@earendil-works/chord'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { LandingSubject } from '../workspaces/types.ts'
import type { accountResponse, askSummaryModel, SummaryRequest } from './summary.ts'
import type { SummaryModel } from './summary-model.ts'

export type ConversationsService = {
  /** What conversation `id` is about now: its title, summary and feature, for a record that outlives a retitle. */
  subject: (id: ConversationId, caller: Context) => Promise<LandingSubject>
  /** The conversations the user concluded; use it to leave their resources (worktrees) alone or free them. */
  concluded: (caller: Context) => Promise<Set<ConversationId>>
  /** The summary model to ask now, from settings; undefined while none is valid and available. */
  summaryModel(): Promise<SummaryModel | undefined>
  /** Request a summary of `id` inside the trigger's transaction, with the model resolved before it. */
  requestSummary(
    tx: Tx,
    id: ConversationId,
    request: SummaryRequest,
    model: SummaryModel | undefined,
  ): Promise<void>
  /** Ask a summary model once with a system prompt and input, or return the response the receipt already holds. */
  askSummaryModel: typeof askSummaryModel
  /** Add a summary model response's usage to the conversation's `pi.usage` inside `tx`, after asking. */
  accountResponse: typeof accountResponse
}
/** Conversation subjects and the summary model; core, so `need` it. */
export const ConversationsApi = defineApi<ConversationsService>()('conversations')
