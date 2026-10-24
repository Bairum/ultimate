import type { ConversationSummary } from '../../shared/protocol.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { Todo } from '../todos/refs.ts'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { CreateArgs, Schedule } from '../automations/refs.ts'
import type { GrantedBy, Journal, Proposal, Session } from './refs.ts'

/** Everything a dream carries to a fresh chapter; numeric trigger targets and subscribers need recreating. */
export type Seed = {
  /** Written only by the gate: the preview checks automations' schedules instead of creating them. */
  gate?: true
  from: { name: string; number: number }
  session: number
  /** The granted automation that fell asleep for the user; absent when the user did. */
  by?: GrantedBy
  journal: Journal & { proposals: Proposal[] }
  memories: Record<string, MemoryItem>
  todos: Pick<Todo, 'text' | 'owner'>[]
  questions: { text: string; ref: string }[]
  automations: {
    name: string
    prompt?: string
    schedule?: Schedule
    event?: CreateArgs['event']
    condition?: CreateArgs['condition']
    agent?: string
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  }[]
  scripts: {
    id: string
    scope?: 'project'
    name: string
    ask: string
    prompt?: string
    agent?: string
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  }[]
  counts: {
    memories: number
    todos: number
    questions: number
    automations: number
    scripts: number
  }
  /**
   * The built-in "Dream before compaction" automation, recreated in the new chapter as it was; `null` when the user
   * deleted it. Absent in seeds from before it existed: the new chapter makes it.
   */
  builtIn?: { enabled: boolean } | null
  /**
   * What @ultimate was doing in conversation `conversation` of the chapter it left, so the new chapter continues it:
   * the handoff it wrote for the dream, else its latest compaction summary (capped at 12,000 characters).
   */
  continues?: { conversation: number; handoff?: string; summary?: string }
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

/**
 * The session the status line keeps in view: the open one, or the newest once every proposal settled while its Fall
 * asleep is still to come (a granted sleep under way included). A session the user ended early, or one a compaction's
 * dream settled to stay, is done.
 */
export function pinnedOf(sessions: readonly Session[] = []): Session | undefined {
  const open = sessions.find((item) => item.endedAt === undefined)
  if (open) return open
  const newest = sessions.at(-1)
  if (!newest?.journal || newest.sleep?.phase === 'asleep') return undefined
  if (newest.proposals.some((item) => item.status === 'open' || item.status === 'approved'))
    return undefined
  if (newest.beforeCompaction?.outcome?.result === 'stay') return undefined
  return newest
}

/**
 * Whether the pinned dialog leads with Fall asleep (or its progress, or its failure): the newest session, or one that
 * slept, once no proposal is open or on a branch, whichever card in the conversation carries Fall asleep.
 */
export function sleepLeads(session: Session, newest: boolean) {
  if (!session.journal || !(newest || session.sleep)) return false
  return (
    !!session.sleep ||
    !session.proposals.some((item) => item.status === 'open' || item.status === 'approved')
  )
}

const settled = (session: Session) =>
  session.proposals.filter((item) => item.status !== 'open' && item.status !== 'approved').length

/** Where the session stands, in a few words: dreaming, deciding, waiting on branches, or ready to fall asleep. */
export function progress(session: Session): { long: string; short?: string; moons?: true } {
  if (session.sleep)
    return { long: session.sleep.phase === 'failed' ? 'falling asleep failed' : 'falling asleep' }
  if (!session.journal) return { long: 'dreaming', moons: true }
  const total = session.proposals.length
  const done = settled(session)
  if (session.endedAt !== undefined || done === total) return { long: 'ready to fall asleep' }
  const open = session.proposals.filter((item) => item.status === 'open').length
  const approved = total - done - open
  const rest = [open > 0 && `${open} to decide`, approved > 0 && `${approved} on branches`]
  return {
    long: [`${done} of ${total} settled`, ...rest].filter(Boolean).join(' · '),
    short: `${done}/${total}`,
  }
}
