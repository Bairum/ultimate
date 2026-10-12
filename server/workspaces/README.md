# Workspace naming and ownership

New workspaces use `<home>/worktrees/w-<hash>` and branch `ultimate/w-<hash>`, where
`<hash>` is the first 10 lowercase hexadecimal characters of SHA-256 of the full
request string (40 bits). Agent names do not affect new physical names. Both core
`describe` and creation use the same deterministic naming function. The UI's
`W<conversationId>` label is separate; tools and diagnostics retain full paths.

Short names are not ownership evidence. New `<short name>.ready` markers use the
existing marker mechanism and store the full request plus workspace identity.
Creation exclusively claims this marker with `preparation: pending` before Git
mutation, then atomically publishes `ready` after setup. Because colliding short
names share a single marker, concurrent requests cannot each claim ownership.
The durable preparation task also retains the full request. There is no separate
identity registry.

Replay checks request, source, path, branch, base, home containment and registered
Git branch before returning a ready workspace or resuming pending setup. An
unrelated existing branch, path, registration or marker is refused, not adopted,
overwritten, renamed or force-cleaned. Different homes cannot share a branch by
presenting the same request. Truncated-hash collisions fail closed and require
explicit inspection rather than suffix allocation or automatic retries.

Prepared durable path/branch identities take precedence over new naming. Existing
long paths and branches are never renamed. Legacy full-hash markers without a request remain
valid at their original full-hash path with the matching persisted workspace (or
original agent branch for direct replay); ready legacy markers are not rewritten.
Pending legacy setup resumes at that saved path/branch, not a newly shortened one.
An interrupted legacy preparation can also resume from its durable document before
its marker exists, but only at the original full request-hash path and original
agent/hash branch. A short-name registration without a matching request marker
fails closed, even when a pending document happens to name that path/branch.

Setup failure retains the existing clean-only Git removal behavior: valuable dirty
or untracked output is never force-removed, and branches are retained. A removed
checkout's retained branch is not automatically adopted on retry. If publication
was interrupted after writing a complete `.ready.tmp`, replay promotes that file
without rerunning setup, but only with an owned pending marker, matching registered
worktree, and exact full request/workspace identity. Foreign, partial or non-file
temporary checkpoints are refused and preserved for explicit inspection; creation
never overwrites them. Setup commands must remain replay-safe when interrupted
before the complete temporary ready marker is written.

Verification: `pnpm test test/workspace-naming.test.ts test/workspaces.test.ts test/subagents-worktrees.test.ts --maxWorkers=2`.
The naming suite includes sequential and concurrent real 40-bit truncated SHA-256
collisions, unrelated branch/path/marker refusals, cross-home ownership, replay,
and long-name resume.
