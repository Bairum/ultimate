import type { ConversationSummary } from '../../shared/protocol.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { Todo } from '../todos/refs.ts'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { Schedule } from '../automations/refs.ts'
import type { Journal, Proposal } from './refs.ts'

/** Everything a dream carries to a fresh chapter; no runtime ids for schedules or subscribers. */
export type Seed = {
  /** Written only by the gate: the preview checks automations' schedules instead of creating them. */
  gate?: true
  from: { name: string; number: number }
  session: number
  journal: Journal & { proposals: Proposal[] }
  memories: Record<string, MemoryItem>
  todos: Pick<Todo, 'text' | 'owner'>[]
  questions: { text: string; ref: string }[]
  automations: {
    name: string
    prompt: string
    schedule: Schedule
    agent?: string
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  }[]
  subscriptions: { id: string; scope?: 'project'; title: string; ask: string }[]
  counts: {
    memories: number
    todos: number
    questions: number
    automations: number
    subscriptions: number
  }
}

/** The five passes a dream runs, in the order the journal lists them. */
export const PASSES = ['memory', 'failures', 'tools', 'corrections', 'codify'] as const
export type PassName = (typeof PASSES)[number]

/** Top-level conversations at work besides @ultimate: a dream reads finished work, not work in progress. */
export function busyElsewhere(conversations: readonly ConversationSummary[], ultimate?: number) {
  return conversations
    .filter((item) => item.busy && item.id !== ultimate && item.parentConversationId === undefined)
    .map((item) => ({ id: item.id, title: item.title ?? `#${item.id}` }))
}
