import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

export interface Switch {
  model?: { from: string; to: string }
  thinking?: { from: string; to: string }
}

const responseOf = (entry: EntryRecord): AssistantMessage | undefined => {
  const message = entry.model?.[0]
  return entry.kind === 'pi.assistant' && message?.role === 'assistant' ? message : undefined
}

/**
 * What changed since the response before `entry`: its model, and its thinking level where the provider reports the
 * level it used (`providerThinkingLevel`). Undefined for the first loaded response and for one that changed nothing.
 */
export function switchAt(entries: readonly EntryRecord[], entry: EntryRecord): Switch | undefined {
  const response = responseOf(entry)
  if (!response) return undefined
  let previous: AssistantMessage | undefined
  let thinking: string | undefined
  for (let index = entries.indexOf(entry) - 1; index >= 0; index--) {
    const message = responseOf(entries[index])
    if (!message) continue
    previous ??= message
    thinking = message.providerThinkingLevel
    if (thinking || !response.providerThinkingLevel) break
  }
  if (!previous) return undefined
  const change: Switch = {}
  if (previous.provider !== response.provider || previous.model !== response.model) {
    const named = (message: AssistantMessage) =>
      previous?.provider === response.provider
        ? message.model
        : `${message.provider}/${message.model}`
    change.model = { from: named(previous), to: named(response) }
  }
  if (thinking && response.providerThinkingLevel && thinking !== response.providerThinkingLevel)
    change.thinking = { from: thinking, to: response.providerThinkingLevel }
  return change.model || change.thinking ? change : undefined
}
