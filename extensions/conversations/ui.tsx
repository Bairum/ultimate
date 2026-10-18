/**
 * Conversations for other extensions' browser code: references to conversations with their features, agent marks,
 * the primary agent, which conversations a conclusion hides, the overview document and the conversation actions, and
 * the points where optional extensions describe a conversation (its working phase, its plan task).
 */
import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'

/**
 * What a working conversation `id` is doing (`phase` provides it): `label` for a row's activity line, `word` in lower
 * case in place of "working", and whether it only `waiting` on its subagents. Undefined while not known.
 */
export const ConversationPhase = definePoint<
  number | undefined,
  { label: ReactNode; word: string; waiting: boolean } | undefined
>('conversations.phase')
/** The plan task conversation `id` works on (`plan` provides it): its chip and title. */
export const ConversationTask = definePoint<
  number | undefined,
  { chip: ReactNode; title: string } | undefined
>('conversations.task')

export { ConversationRef, FeatureTag, useOverview } from './feature.tsx'
export { AgentMark, agentTitle } from './marks.tsx'
export type { Presence } from './marks.tsx'
export { usePrimaryAgent } from './primary.tsx'
export { hiddenConversationIds } from './visible.tsx'
export { ConcludeAction, OverviewDoc, RenameAction, ResumeAction } from './refs.ts'
