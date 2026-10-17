import { join } from 'node:path'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { JsonObject } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings } from '../onboarding/settings.ts'
import { parseSummaryModel } from './summary-model-ref.ts'

/** Titles, summaries and reply assessments use this model unless settings name another. */
export const DEFAULT_SUMMARY_MODEL = 'openai/gpt-6-luna:medium'

/** A resolved summary model, kept in a task's memo so a resumed task asks the same one. */
export type SummaryModel = { provider: string; id: string; thinking: ModelThinkingLevel }

export type SummaryModelHost = Pick<ExtensionHost, 'userHome' | 'projectSettings' | 'notice'> &
  Pick<Partial<ExtensionHost>, 'faux'> & {
    modelRuntime: Pick<ExtensionHost['modelRuntime'], 'getAvailableSnapshot'>
  }

/** The configured value and where it comes from: the project's settings override the user's. */
export async function summaryModelSetting(
  host: Pick<SummaryModelHost, 'userHome' | 'projectSettings'>,
) {
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const user: JsonObject = await readSettings(join(host.userHome, '.ultimate/settings.json')).catch(
    () => ({}),
  )
  const project = await host.projectSettings()
  for (const [source, settings] of [
    ['project', project],
    ['user', user],
  ] as const)
    if (Object.hasOwn(settings, 'summaryModel'))
      return { value: settings.summaryModel, source, default: DEFAULT_SUMMARY_MODEL }
  return {
    value: DEFAULT_SUMMARY_MODEL,
    source: 'default' as const,
    default: DEFAULT_SUMMARY_MODEL,
  }
}

const reported = new Set<string>()

/**
 * The summary model to ask now, read from settings at each request so a change applies to the next one. An invalid
 * value is reported once as a notice; an invalid or unavailable model is undefined, so callers skip quietly.
 */
export async function summaryModel(host: SummaryModelHost): Promise<SummaryModel | undefined> {
  const { value, source } = await summaryModelSetting(host)
  if (host.faux && source === 'default') return { provider: 'faux', id: 'faux-1', thinking: 'off' }
  const parsed = typeof value === 'string' ? parseSummaryModel(value) : undefined
  if (!parsed) {
    const message = `Invalid summaryModel ${JSON.stringify(value)} in ${source} settings: expected "provider/id[:thinking]"; summaries are off`
    if (!reported.has(message)) {
      reported.add(message)
      host.notice(message)
    }
    return undefined
  }
  const model = host.modelRuntime
    .getAvailableSnapshot()
    .find((candidate) => candidate.provider === parsed.provider && candidate.id === parsed.id)
  if (!model) return undefined
  return {
    provider: model.provider,
    id: model.id,
    thinking: clampThinkingLevel(model, parsed.thinking ?? 'medium'),
  }
}
