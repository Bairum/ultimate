/** Review in the browser: the local diff of a spec, and the specs worth choosing from. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * What to review, as text: `uncommitted` (the work tree against `HEAD`, untracked files included), a commit (`<sha>`
 * or any ref naming one), a range `<a>...<b>` (what `b` changed since it forked from `a`, as a landing's
 * `<base>...<sha>`), or `branch:<name>` (the branch against the target branch it lands on).
 */
export type ReviewKind = 'uncommitted' | 'commit' | 'range' | 'branch'

/** One changed file. Its hunks are in the diff's `patch` unless it is `binary`, `tooLarge` or `typeChanged`. */
export type ReviewFile = {
  /** The path after the change; the old path for a deleted file. */
  path: string
  /** The path before a rename or copy. */
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'
  additions: number
  deletions: number
  binary?: boolean
  /** Its patch was over the per-file cap, or past the whole diff's cap: listed, its hunks left out. */
  tooLarge?: boolean
  /** It became a symlink or stopped being one (Git's `T`): listed, its hunks left out. */
  typeChanged?: boolean
}

export type ReviewDiff = {
  /** The spec as asked. */
  spec: string
  kind: ReviewKind
  /** One line naming what is shown: `Uncommitted changes`, a commit's subject, `main...feature`. */
  title: string
  /** The full shas compared, where there are two commits: the merge base (or parent) and the tip. */
  base?: string
  head?: string
  /** `git diff` output of every file that fits, for `parsePatchFiles` of `@pierre/diffs`. */
  patch: string
  files: ReviewFile[]
  /** The diff was bigger than the whole cap: later files are listed without hunks. */
  truncated?: boolean
}

/** One choice of the range selector. */
export type ReviewRange = {
  spec: string
  group: 'Working tree' | 'Branches' | 'Landings' | 'Commits'
  /** What it is, in a few words: a branch's conversation title, a landing's feature, a commit's subject. */
  label: string
  /** Quiet meta: a short sha, an age. */
  detail?: string
}

/**
 * `{ spec, conversation? }` → the diff of `spec` in the project's checkout, or in conversation `conversation`'s
 * worktree while it has one. Throws on a spec or ref Git does not know as a commit, and on any part starting with `-`.
 */
export const DiffAction = actionRef<{ spec: string; conversation?: number }, ReviewDiff>(
  'review',
  'diff',
)
/** No arguments → recent specs to choose from: uncommitted, open `ultimate/*` branches, landings and commits. */
export const RangesAction = actionRef<null, ReviewRange[]>('review', 'ranges')
