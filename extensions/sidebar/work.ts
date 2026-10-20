/** An in-flight branch's work so far, as its row shows it: commits on its worktree branch, and uncommitted edits. */
export type Work = {
  /** Commits not yet on its target, and the Review spec of them (the branch against its target). */
  commits?: { count: number; spec: string }
  /** Uncommitted changes in its worktree, and the Review spec of them. */
  edits?: { count: number; spec: string }
}

/**
 * What a branch's worktree (`workspaces.progress`: `unlanded` commits, `uncommitted` changed paths) shows on its row;
 * nothing for a worktree with neither, or none.
 */
export function workOf(
  id: number,
  branch: string | undefined,
  progress: { unlanded: number; uncommitted: number } | undefined,
): Work | undefined {
  if (!progress || !branch) return undefined
  const work: Work = {
    ...(progress.unlanded > 0 && {
      commits: { count: progress.unlanded, spec: `branch:${branch}` },
    }),
    ...(progress.uncommitted > 0 && {
      edits: { count: progress.uncommitted, spec: `uncommitted:${id}` },
    }),
  }
  return work.commits || work.edits ? work : undefined
}
