/**
 * Workspaces for other extensions' browser code: each conversation's worktree and the lander queue, landing links,
 * and the actions that inspect worktrees.
 */
export { stateLabel, useWorkspaceConversations, useWorkspaceIndex, useWorkspaces } from './data.tsx'
export type { WorkspaceConversation } from './data.tsx'
export { CommitCount, Open, useGithubRepo } from './landing.tsx'
export { InfoAction, IsolationAction, PendingAction, WorkspacesDoc } from './refs.ts'
