/**
 * Conversations for other extensions' browser code: references to conversations with their features, agent marks,
 * the primary agent, which conversations a conclusion hides, the overview document and the conversation actions.
 */
export { ConversationRef, FeatureTag, useOverview } from './feature.tsx'
export { AgentMark, agentTitle } from './marks.tsx'
export type { Presence } from './marks.tsx'
export { usePrimaryAgent } from './primary.tsx'
export { hiddenConversationIds } from './visible.tsx'
export { ConcludeAction, OverviewDoc, RenameAction, ResumeAction } from './refs.ts'
