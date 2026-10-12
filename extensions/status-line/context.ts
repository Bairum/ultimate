import type { Usage } from '@earendil-works/pi-ai'
import type { EntryRecord, UsageState } from '@earendil-works/pi-durable'

/** What a response's prompt took: the context it was sent with. */
export const promptTokens = (usage: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>) =>
  usage.input + usage.cacheRead + usage.cacheWrite

/**
 * The latest answer, searching from the newest entry. After a compaction or reset the context size is unknown
 * (`stale`) until the next response; without either, an empty context.
 */
export function lastAssistant(entries: readonly EntryRecord[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') return { stale: true }
    const message = entry.model?.[0]
    if (entry.kind === 'pi.assistant' && message?.role === 'assistant')
      return { message, stale: false }
  }
  return { stale: false }
}

/** A conversation's own spend: every model and tool bucket of its `pi.usage`, added up. */
export function usageTotals(usage: Readonly<UsageState>) {
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce(
    (sum, bucket) => ({
      input: sum.input + bucket.input,
      output: sum.output + bucket.output,
      cacheRead: sum.cacheRead + bucket.cacheRead,
      cacheWrite: sum.cacheWrite + bucket.cacheWrite,
      cost: sum.cost + bucket.cost.total,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )
}
