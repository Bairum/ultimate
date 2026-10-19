The Review surface: the project's local Git diffs, its files on the left and their changes on the right, rendered with `@pierre/diffs` in Ultimate's fonts and colours.

What it shows is a **spec**:

- `uncommitted`: the work tree against `HEAD`, untracked files included (ignored ones not).
- `<sha>` (or any ref naming a commit): that commit against its first parent; a root commit against the empty tree.
- `<a>...<b>`: what `b` changed since it forked from `a`, as a landing's `<base>...<sha>`.
- `branch:<name>`: the branch against the target branch it lands on (its worktree's target, else the project checkout's branch).

The header picks the spec (recent choices from `ranges`, or any spec typed in), sums `+N −M · K files`, switches split and
unified, and links the range to DiffsHub when `origin` is on GitHub. On a phone the file list is a dropdown and the
diff is unified. The diff stack is virtualized; the viewer loads with the surface, not with the app.

Links: `/?review=<spec>` opens Review at that spec, and the address carries `?review=` while Review is on screen.
`openReview(spec)` from `ui.tsx` does the same from code. Review provides the `workspaces.review` point, so the
landing card, the Activity feed and a root's landed list open a landing's commit count here (DiffsHub stays as a small
↗ beside it), and a branch row's menu has **Review changes**. Without review those stay plain DiffsHub links.

Actions (`refs.ts`):

- `diff { spec, conversation? }` → `{ spec, kind, title, base?, head?, patch, files, truncated? }`. Runs in
  `conversation`'s worktree while it has one, else the project checkout. Every ref is checked with
  `git rev-parse --verify` as a commit, and any part starting with `-` is refused. A file's patch over 400 KB is listed
  as `tooLarge` without hunks; past 8 MB in all, later files are too and the diff is `truncated`.
- `ranges` → recent specs: uncommitted, open `ultimate/*` branches with their conversation, the last ten landings
  (`workspaces.landed` events) and the last fifteen commits.
