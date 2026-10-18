## Durability

Conversations, tool calls, subagents, and documents are committed to SQLite (`$ULTIMATE_HOME/state.sqlite`, default
`~/.ultimate/projects/<name>-<hash>/`) before anything is shown. A restart or crash resumes the run from its last checkpoint. A tool declared
`replay: "safe"` reruns after a crash; any other interrupted tool reports "interrupted" to the model. Make a tool
replay-safe only if a rerun cannot do harm, and store decisions in `api.memo()`.
Every `replay: 'safe'` declaration needs a preceding reason comment, enforced by `ultimate/replay-safe-reason`.

Each folder keeps its own conversations in that central projects directory. Homes describe themselves with `project.json` and debounced `conversations.json`; `host.projects()` (or `ultimate.projects()` in codemode) lists these manifests and live supervisor URLs without opening another project's SQLite.

The web SDK's `useUiState(key, initial)` stores shared durable UI state; scroll positions and drafts stay in the browser.
The host owns `ultimate.ui` on the root conversation, persisted in SQLite and copied as of the fork entry.
