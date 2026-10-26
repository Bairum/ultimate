/**
 * Classify: typed judgments (choice, yes/no, score) over JSON state from TypeSafe's models, for extensions that need a
 * cheap structured verdict instead of a chat completion.
 */
import type { JsonValue } from '@earendil-works/chord'
import { defineApi } from '../../shared/extension-api.ts'
import type { ClassifyAnswer, ClassifyQuestion } from './refs.ts'

export type { ClassifyAnswer, ClassifyQuestion } from './refs.ts'

/** Every answer by question id, the model that gave them and the input tokens used. */
export type ClassifyResult = {
  model: string
  answers: Record<string, ClassifyAnswer>
  usage: { inputTokens: number }
}

export type ClassifyService = {
  /**
   * Answer `questions` about `state`: cached answers locally, the rest in one request; throws without
   * `TYPESAFE_API_KEY` (when anything is uncached) or on a malformed response.
   */
  ask(
    request: { state: JsonValue; questions: Record<string, ClassifyQuestion> },
    signal: AbortSignal,
  ): Promise<ClassifyResult>
}

/** Typed judgments over JSON state; `want` it, since classify is optional and needs a TypeSafe key. */
export const ClassifyApi = defineApi<ClassifyService>()('classify')
