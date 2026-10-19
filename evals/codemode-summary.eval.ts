import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { appendFile } from 'node:fs/promises'
import { expect, inject, test } from 'vitest'
import { askSummaryModel } from '../extensions/conversations/summary.ts'
import { DEFAULT_SUMMARY_MODEL } from '../extensions/conversations/summary-model.ts'
import { parseSummaryModel } from '../extensions/conversations/summary-model-ref.ts'
import { parseSummary, SUMMARY_SYSTEM, summaryInput } from '../extensions/codemode/summary.ts'
import type { Call } from '../extensions/codemode/summary.ts'
import { cases } from './codemode-summary.cases.ts'
import type { TurnUsage } from './reporter.ts'

/** Summarize a script with the default summary model, as codemode does, and record the call's usage. */
async function summarize(calls: Call[], error?: string) {
  const parsed = parseSummaryModel(DEFAULT_SUMMARY_MODEL)!
  const model = { provider: parsed.provider, id: parsed.id, thinking: parsed.thinking ?? 'off' }
  const started = performance.now()
  const response = await askSummaryModel(
    await ModelRuntime.create(),
    SUMMARY_SYSTEM,
    summaryInput(calls, error),
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
  return parseSummary(response.text)
}

// Only the calls and a failure's error reach the model; the script and its result stay home.
test.concurrent.each(cases)('$name', async ({ calls, result, effect, says }) => {
  const summary = await summarize(
    calls,
    result.startsWith('Script failed') ? result.split('\n').at(-1) : undefined,
  )
  expect(summary.line.length).toBeLessThanOrEqual(120)
  expect(summary.line).toMatch(new RegExp(says.source, 'i'))
  expect({ line: summary.line, effect: summary.effect === true }).toMatchObject({ effect })
})
