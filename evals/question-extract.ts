import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { appendFile } from 'node:fs/promises'
import { expect, inject } from 'vitest'

import { askSummaryModel } from '../extensions/conversations/summary.ts'
import { DEFAULT_SUMMARY_MODEL } from '../extensions/conversations/summary-model.ts'
import { parseSummaryModel } from '../extensions/conversations/summary-model-ref.ts'
import { parseQuestions, QUESTIONS_SYSTEM } from '../extensions/questions/server.ts'
import type { Question } from '../extensions/questions/types.ts'
import type { decisionCases } from './questions.cases.ts'
import type { TurnUsage } from './reporter.ts'

/** Extract with the default summary model, as the questions extension does, and record the call's usage. */
export async function extract(reply: string) {
  const parsed = parseSummaryModel(DEFAULT_SUMMARY_MODEL)!
  const model = { provider: parsed.provider, id: parsed.id, thinking: parsed.thinking ?? 'off' }
  const started = performance.now()
  const response = await askSummaryModel(
    await ModelRuntime.create(),
    QUESTIONS_SYSTEM,
    reply,
    AbortSignal.timeout(120_000),
    { model },
  )
  const measured: TurnUsage = {
    model: `${model.provider}/${model.id}`,
    tokens: response.usage?.totalTokens ?? 0,
    cost: response.usage?.cost.total ?? 0,
    wallMs: performance.now() - started,
  }
  await appendFile(inject('evalUsageFile'), JSON.stringify(measured) + '\n')
  expect(response.stopReason).toBe('stop')
  return parseQuestions(response.text)
}

/**
 * A real ask's extraction in the shape its expected values use: count, options per question (a confirm is 2) and
 * the recommended index where the message states a pick (null where it states none: a model's guess is tolerated).
 */
export function shape(
  questions: Question[],
  { rec }: Pick<(typeof decisionCases)[number], 'rec'>,
): Pick<(typeof decisionCases)[number], 'n' | 'opts' | 'rec'> {
  return {
    n: questions.length,
    opts: questions.map((q) => (q.kind === 'confirm' ? 2 : q.options!.length)),
    rec: questions.map((q, i) =>
      rec[i] === null || rec[i] === undefined
        ? null
        : (q.options?.findIndex((o) => o.recommended) ?? -1),
    ),
  }
}
