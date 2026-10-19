import type { AssistantMessage, Message, Tool, Usage } from '@earendil-works/pi-ai'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { EntryRecord, UsageState } from '@earendil-works/pi-durable'

/** What a response's prompt took: the context it was sent with. */
export const promptTokens = (usage: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>) =>
  usage.input + usage.cacheRead + usage.cacheWrite

/**
 * The latest answer. After a compaction or reset (`marker`) the measured context size is `stale` until a newer
 * response; without either, an empty context. A compaction's view lists its marker before the kept entries, so entry
 * IDs, not positions, tell which came last.
 */
export function lastAssistant(entries: readonly EntryRecord[]) {
  let marker: EntryRecord | undefined
  let message: AssistantMessage | undefined
  let answered = -1
  for (const entry of entries) {
    if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') {
      if (!marker || entry.id > marker.id) marker = entry
    }
    const model = entry.model?.[0]
    if (entry.kind === 'pi.assistant' && model?.role === 'assistant' && entry.id > answered) {
      message = model
      answered = entry.id
    }
  }
  if (marker && answered < marker.id) return { stale: true, marker: marker.id }
  return message ? { message, stale: false } : { stale: false }
}

/**
 * Estimated tokens of the next request after a compaction or reset, before a response measures it: the system prompt
 * and tools in effect at the end of the `previous` context, replayed from its system messages, plus the `current`
 * context's other messages (the summary or handoff and the kept entries). Generation writes a fresh baseline after a
 * head marker, so system messages kept in `current` do not count twice.
 */
export function estimateAfterHead(previous: readonly Message[], current: readonly Message[]) {
  let base: Extract<Message, { role: 'system' }>['content'] | undefined
  const sections = new Map<string, string>()
  const tools = new Map<string, Tool>()
  for (const message of previous) {
    if (message.role !== 'system') continue
    base ??= message.content
    for (const [name, text] of Object.entries(message.sections ?? {}))
      if (text === null) sections.delete(name)
      else sections.set(name, text)
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  const system = estimateMessageTokens({
    role: 'system',
    content: base ?? '',
    sections: Object.fromEntries(sections),
    toolsAdded: [...tools.values()],
    timestamp: 0,
  })
  return current
    .filter((message) => message.role !== 'system')
    .reduce((sum, message) => sum + estimateMessageTokens(message), system)
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
