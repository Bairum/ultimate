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

Main-agent own-land tooling/guidance and guarded restart reuse are separate follow-up work, not part of this UI.
