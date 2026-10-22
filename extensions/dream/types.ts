import type { ConversationSummary } from '../../shared/protocol.ts'

/** The five passes a dream runs, in the order the journal lists them. */
export const PASSES = ['memory', 'failures', 'tools', 'corrections', 'codify'] as const
export type PassName = (typeof PASSES)[number]

/** Top-level conversations at work besides @ultimate: a dream reads finished work, not work in progress. */
export function busyElsewhere(conversations: readonly ConversationSummary[], ultimate?: number) {
  return conversations
    .filter((item) => item.busy && item.id !== ultimate && item.parentConversationId === undefined)
    .map((item) => ({ id: item.id, title: item.title ?? `#${item.id}` }))
}
