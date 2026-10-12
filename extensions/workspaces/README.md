# Workspaces

Built-in, enabled through source defaults. A quiet right-panel tab manages core-owned isolated checkouts, including
all empty, archived, pending, failed and removed drafts. No new surface, preview autostart or configuration changes.
Use Conversations → New options → New isolated conversation to opt in. Ordinary New stays shared.

Rows use `W<conversationId>` only. Expand details for full path, branch, captured source and target, with copy buttons.
Removed records remain visible. Ready describes preparation, not task completion or whether changes are applied.
Last landed is a factual saved SHA; even if the own branch tip changes it is never a Done/applied marker. Refresh
fetches current core info and its commits-ahead count. Busy runs, setup and lifecycle errors remain visible with safe
inspect/refresh/retry-after-resolving guidance. Failed setup has no retry API: inspect the actual error, explicitly
remove a clean checkout or create a new isolated conversation; UI never marks it Ready or bypasses admission.

Land verified tip calls the existing core pinned-SHA, fast-forward-only lifecycle. Remove checkout asks explicitly
for clean-only confirmation and keeps the branch, commits and conversation history. Dirty work, active dependent
workspaces, execution and preview leases are core refusals; there is no force cleanup. Archive and clear context are
conversation operations only, never Git removal. Nothing restarts the host or starts a preview.

The server factory fails before installation without core `workspaces.doc`, `info` and `runLifecycle`. Actions:

- `info {id}` returns core workspace info (or null without a workspace).
- `land {id}` runs the core conversation-owned landing lifecycle.
- `discard {id, confirm: true}` runs the core clean-only discard lifecycle; missing confirmation refuses.

Every id must be a positive safe integer. Actions use the shown conversation as lifecycle owner (target if absent).
The browser calls them on the target conversation and requires `system.execution.workspaces === true` for controls.
No extension-owned Git execution, lifecycle documents, schema or naming rules; core remains authoritative.

## Main-agent completion

The built-in `workspace {action: "status" | "land"}` tool is for top-level main conversations only; workers and
history forks cannot use it to land themselves. Status includes live `tip`, `sourceTip`, `currentBranch` and `sourceBranch`, the saved last landed SHA,
and captured destination, or null for a shared conversation. Own land uses core `createLifecycle`, owned by the
calling task, with a request keyed by conversation and `api.callId`. Nested codemode calls share `taskId`, not request
identity. Replay returns the same lifecycle result without another merge; a new call verifies its current pinned tip.
Only the caller's orchestration ancestry is exempt from busy guards, never other running/queued work or previews.

For an isolated main: independently verify each worker and land it into the main workspace; review and verify the
final combined committed tip; explicitly call `workspace land` into the captured original checkout/branch; then use
`workspace status` to verify live tip = sourceTip = returned landed SHA, currentBranch = saved workspace branch, and
sourceBranch = captured targetBranch. Never assume the target is `main`. If source
advances, update the isolate and reverify before retrying. Dirty, busy, diverged, detached and changed-branch targets
are blockers, not success. No auto-rebase, cleanup, remote push or generic deployment. Shared mains retain the ordinary
verified children → shared source flow and do not have an own workspace to land.

When Ultimate core changes need application, an isolated main deliberately calls the existing `restart` tool with
`applyHost: true` only after final own landing into the actual running Ultimate checkout. Core proof requires a
ready/active main workspace, its correct current branch and cwd, clean own/destination checkouts, the unchanged
non-null captured target branch, and exact equality of own tip, recorded landed tip and source tip. Unknown, unlanded,
dirty, wrong-host/branch and moved-source conditions refuse before restart or memo effects. Core proof reserves the
own/destination checkout through the existing durable lifecycle queue. Same-source pending mutations (including a
sibling paused before FF) fail closed; new related lifecycle operations and execution admissions are blocked while
reserved. Approval rechecks the pinned proof and checkpoints handoff before writing the restart memo. Failed
preparation/cancel releases a pre-approval reservation; an approved handoff stays pinned even if its caller stops,
until storage reopen. Active callers resume the same proof reservation and release it after memo replay/rollback. No separate restart implementation or raw-POST bypass. The self facet eagerly
requires the new core proof capability, so a failed replacement leaves its previous working facet installed.

Host apply affects every conversation. Honor coordinator/user authorization and supervisor-owned rollout: report
ready or the apply blocker rather than taking an unauthorized restart. Do not report Done at the conversation branch
unless the user explicitly requested branch-only work. Final completion means the requested source revision and any
required authorized host application have been verified. Landing itself never restarts the host.
