import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

const levels: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * `provider/id[:thinking]`, without fuzzy matching; undefined when malformed. Only a recognized final thinking level is
 * stripped, so model ids may contain colons. Browser-safe: the web facet shares it.
 */
export function parseSummaryModel(value: string) {
  const colon = value.lastIndexOf(':')
  const thinking =
    colon !== -1 && levels.includes(value.slice(colon + 1)) ? value.slice(colon + 1) : undefined
  const ref = thinking ? value.slice(0, colon) : value
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1 || /\s/.test(ref)) return undefined
  return {
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    thinking: thinking as ModelThinkingLevel | undefined,
  }
}
