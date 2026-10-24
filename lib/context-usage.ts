import type { AssistantMessage, Message, Tool, Usage } from '@earendil-works/pi-ai'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { EntryRecord } from '@earendil-works/pi-durable'

/** What a response's prompt took: the context it was sent with. */
export const promptTokens = (usage: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>) =>
  usage.input + usage.cacheRead + usage.cacheWrite

/** Context fill; absent tokens or window leave the percentage unknown. */
export function contextUsage(
  { tokens, window, estimated }: { tokens?: number; window?: number; estimated?: boolean },
  at: number,
) {
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(window === undefined ? {} : { window }),
    ...(tokens === undefined || !window ? {} : { percent: (tokens / window) * 100 }),
    ...(estimated === undefined ? {} : { estimated }),
    at,
  }
}

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
