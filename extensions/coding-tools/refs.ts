/** Coding tools in the browser: the event each commit made through the bash tool records. Browser-safe. */
import { defineEvent } from '../../shared/events.ts'

/**
 * Conversation `conversation` made commit `sha` (full) through the bash tool, in repository `repo` (its main
 * checkout, or the bare repository); `worktree` is the linked checkout it was made in, `branch` the checked-out branch
 * (absent when detached). `rewrittenFrom` is the commit an amend or rebase replaced. Recorded after the bash call, in a
 * commit of its own, so it outlives the commit and its worktree.
 */
export const Committed = defineEvent<{
  conversation: number
  sha: string
  parents: string[]
  repo: string
  worktree?: string
  branch?: string
  subject: string
  rewrittenFrom?: string
}>('coding-tools.committed')
