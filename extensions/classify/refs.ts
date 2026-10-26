/** Classify's question and answer types and its actions: one question set over many states, and the daily spend ledger. Browser-safe. */
import type { JsonValue } from '@earendil-works/chord'
import { actionRef } from '../../shared/extension-api.ts'

/** One question: its instructions and the criteria for each choice, outcome or score. */
export type ClassifyQuestion =
  | { type: 'choice'; instructions: JsonValue; criteria: Record<string, JsonValue> }
  | { type: 'noul'; instructions: JsonValue; criteria?: { true?: JsonValue; false?: JsonValue } }
  | { type: 'score'; instructions: JsonValue; criteria: JsonValue[] }

/** The answer to one question, with its confidence. */
export type ClassifyAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | {
      type: 'score'
      score: number
      confidence: number
      probabilities: Record<string, number>
      legend: Record<string, JsonValue>
    }

/** One UTC day of `ask` calls: TypeSafe requests sent, questions served from cache or sent, input tokens and USD. */
export type DayStats = {
  day: string
  requests: number
  cachedQuestions: number
  sentQuestions: number
  inputTokens: number
  usd: number
}

/** The ledger of the last `days` UTC days (default 7), newest first, and the answer cache's rows and bytes. */
export const StatsAction = actionRef<
  { days?: number } | null,
  { days: DayStats[]; cache: { rows: number; bytes: number } }
>('classify', 'stats')

/**
 * The same `questions` over each of `states` (an array, keyed by index, or a map), at most 8 at a time; each state's
 * answers or its error by key, and the input tokens the batch spent.
 */
export const BatchAction = actionRef<
  { states: JsonValue[] | Record<string, JsonValue>; questions: Record<string, ClassifyQuestion> },
  {
    results: Record<string, Record<string, ClassifyAnswer> | { error: string }>
    usage: { inputTokens: number; usd: number }
  }
>('classify', 'batch')
