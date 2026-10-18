/**
 * Workspaces: isolated Git worktrees for conversations and the lander that merges them into their target branch.
 * Other extensions create, look up, land and discard a conversation's worktree through this service.
 */
import { defineApi } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { git } from '../../lib/git.ts'
import type { Workspaces, workspaces } from './workspaces.ts'

type Implementation = ReturnType<typeof workspaces>

export type WorkspaceService = {
  /** The worktree of conversation `id` (path, branch, target, state), or undefined when it has none. */
  get: Implementation['get']
  /** Give conversation `id` a new worktree of `cwd`'s repository inside `tx`; throws when `cwd` cannot be isolated. */
  create: Implementation['create']
  /** Fast-forward the source checkout to the worktree tip of `id`, as `workspace land` does; returns what landed. */
  land: Implementation['land']
  /** Remove the worktree of `id` without landing it. */
  discard: Implementation['discard']
  /** Free the worktrees of concluded conversations `ids` and their descendants; returns the ones kept (busy, unlanded). */
  release: Implementation['release']
  /** Run `git` with `args` in a directory; rejects with Git's message. Use it instead of spawning Git yourself. */
  git: typeof git
  /** The worktree index document (`ultimate.workspaces` on the root), for reads inside a transaction. */
  doc: typeof Workspaces
  /** Make the project folder a Git repository with a first commit, so worktrees and landing work. */
  setupGit(): Promise<void>
}
/** Worktrees and landing; core, so `need` it. */
export const WorkspacesApi = defineApi<WorkspaceService>()('workspaces')

export type LandedData = {
  /** The submission's id in the lander's queue. */
  submission: string
  /** The submitting conversation, and its latest entry when it submitted. */
  conversationId: number
  at: number
  /** The target's new tip, the tip it moved from, and the branch. */
  sha: string
  base: string
  target: string
  /** The lander conversation that landed it. */
  lander: number
  divergence: string
  /** The submitter's title and summary as they were at submit time. */
  title: string
  summary?: string
  feature?: string
  /** The first ten commits it brought, newest first, out of `commitCount`; the first eight changed paths. */
  commits: { sha: string; subject: string }[]
  commitCount: number
  paths: string[]
  /** `<remote>/<target>` it was pushed to; absent when not pushed or the push failed. */
  pushed?: string
}
/**
 * The lander landed a submission: the target moved to `sha`. Emitted in the commit that records the outcome, also when
 * only the push failed afterwards; react to it for anything that must follow every landing exactly once.
 */
export const SubmissionLanded = defineEvent<LandedData>('workspaces.landed')
export const tier = 'core'
