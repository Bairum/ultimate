/**
 * Workspaces in the browser: the worktree index every conversation's isolate and the lander queue live in, and the
 * actions that inspect worktrees. Browser-safe.
 */
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type {
  WorkspaceDisk,
  WorkspaceIndex,
  WorkspaceInfo,
  WorkspacePending,
  WorkspaceStats,
} from './types.ts'

/** Why the project cannot isolate conversations (`reason`, absent when it can), and whether its folder is empty. */
export type Isolation = { reason?: string; empty?: boolean }

/** The worktree index on the root conversation: each conversation's isolate, the lander queue and recent outcomes. */
export const WorkspacesDoc = docRef<WorkspaceIndex>('ultimate.workspaces')

/** `{ id }` → conversation `id`'s worktree with its branch, tip and changes, or null when it has none. */
export const InfoAction = actionRef<{ id: number }, WorkspaceInfo | null>('workspaces', 'info')
/** `{ ids }` → the unlanded work of these conversations' worktrees, to warn before concluding them. */
export const PendingAction = actionRef<{ ids: number[] }, WorkspacePending[]>(
  'workspaces',
  'pending',
)
/** No arguments → how many worktrees there are in total and in each state, for the workspaces panel. */
export const StatsAction = actionRef<null, WorkspaceStats>('workspaces', 'stats')
/** No arguments → the disk space the worktrees take (on btrfs also with shared blocks counted once), at most a minute old. */
export const DiskAction = actionRef<null, WorkspaceDisk>('workspaces', 'disk')
/**
 * No arguments → whether the project can start isolated conversations; once it can, the project's lander is stood up
 * if it has none.
 */
export const IsolationAction = actionRef<null, Isolation>('workspaces', 'isolation')
