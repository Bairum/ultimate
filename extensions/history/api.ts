/**
 * History: ranked full-text search (FTS5, bm25) over every stored entry of the open chapter, indexed locally in
 * `history.sqlite` beside the chapter's `state.sqlite`. Nothing leaves the machine.
 */
import type { Context } from '@earendil-works/chord'
import { defineApi } from '../../shared/extension-api.ts'

/** One match: the entry, the conversation that wrote it, and a snippet with the matched terms in `**`. */
export type HistoryHit = {
  conversation: number
  entry: number
  kind: string
  /** FTS5 bm25 negated: higher is more relevant. */
  score: number
  snippet: string
}

export type HistoryService = {
  /**
   * Index the entries written since the last call, then return the best `limit` (default 20, at most 100) matches of
   * `query`: every word must match (stemmed, case-insensitive), `"a phrase"` matches in order. `conversationId` limits
   * it to that conversation's fork-aware history. Throws while the harness is not open.
   */
  search(
    query: string,
    options: { limit?: number; conversationId?: number },
    context: Context,
  ): Promise<HistoryHit[]>
}
/** Ranked history search; `want` it, history is optional. */
export const HistoryApi = defineApi<HistoryService>()('history')
export { StatsAction } from './refs.ts'
