Run an async JavaScript function body in a fresh QuickJS/WASM sandbox. Only injected functions can access the host. Prefer it for dependent or parallel tool calls, filtering large outputs, and inspecting Ultimate; use ordinary tools for a single simple operation.

`await tools.<name>(args)` calls the conversation's currently resolved tools, except codemode. Nested calls share the parent durable task (no separate durable tool task), bypass `beforeTool`/`afterTool` hooks, and capture their output privately. Failures reject with the tool's error text. Tools declaring an `outputSchema` and returning `structuredContent` resolve to that JSON; other tools resolve to text. These are Ultimate's own fields, separate from Pi Durable's `structuredOutputSchema` and `structuredOutput`.

`tools.screenshot` and `tools.browser` resolve to `{ title, image?, file?, outcomes }`. `image` is missing when the PNG cannot be resized under the inline image limit; only the saved `file` path comes back, and `image(undefined)` throws. Check it first: `if (shot.image) image(shot.image)`.

`text(value)`, console methods, `image(data)`, and the return value produce model-visible output. Nested-call completion lines stream to `pi.live`; final details contain `{ calls: [{ name, args, status, ms, conversationId?, background? }], value?, error?, subagentAnswers? }`. Script failures preserve output and QuickJS's `codemode.js:<line>` stack. Interrupted scripts are not replayed: Durable returns an interrupted result with the committed partial log. Ordinary nested side effects are never rolled back.

The first line may be `// @options: {"timeout_ms":30000,"max_output_tokens":2000}`. Default timeout is 60 seconds, text output budget is 10,000 estimated tokens, and VM heap limit is 256 MiB. Conversation abort and sandbox deadlines cancel nested work through its context.

## Yielding to steering

When a nested `tools.subagent` result has `details.yielded: true`, codemode synchronously aborts only its sandbox, before returning any value or error to QuickJS. The installed pi-codemode runtime clears pending host replies and terminates the worker before resolving the abort. Script `catch`/`finally`, sequential statements, and `Promise.all` continuations cannot resume. In-flight nested work receives cancellation; child lifetimes and durable answer delivery remain the subagent backend's responsibility.

The outer tool succeeds with the explicit message: **Script yielded to steering; subagents still running; remaining script not executed; prior side effects may have happened.** Details include `yielded: true` and `pendingSubagents: [{ conversationId, background? }]`, preserving the yielding child's ID and known IDs from other cancelled waits. The corresponding call status is `yielded`; other pending calls are `cancelled`. A cancelled start may not yet have returned its new child's ID; the backend must retain that ownership durably. Codemode neither aborts the parent invocation nor reads or consumes steering. Original conversation cancellation still cancels the script, rather than turning into a successful yield.

Successful nested subagent results may carry `details.answerId` (a durable answer entry ID). Only a successful, non-yielded outer completion emits the deduplicated IDs as `details.subagentAnswers: number[]`. Yielded and failed results omit this receipt, even if an earlier child completed in the same script; interrupted tasks likewise do not acknowledge those answers. Nested answers remain private unless the script prints or returns them. The backend queues reports with stable answer IDs immediately, then its `afterTools` hook reads committed tool results and atomically withdraws reports acknowledged by these receipts before the Pi tool-round boundary. It does not wait for the outer task's terminal outcome to enqueue delivery. Codemode does not handle delivery, consume steering, or import the backend runtime.

## Introspection and actions

Only inside codemode (not standalone model tools):

- `ultimate.system()` — machine, process, persistence, resources, build identity.
- `ultimate.projects()` — project folders, their top-level conversation summaries, and URL when running (JSON manifests only, not other stores' SQLite).
- `ultimate.uiState()` — durable root-conversation UI state, so you can see what the user is looking at.
- `ultimate.extensions()` — folders, facets, tools, sections, documents, load errors.
- `ultimate.action(extension, action, args?)` — the one write: call an extension action on behalf of this conversation, with the sandbox abort signal; omitted args become null. Returns its JSON result or throws its error. Discover actions with `ultimate.extensions()` and read their args in the extension README.
- `ultimate.conversations()` — all stored conversation identities and ownership edges.
- `ultimate.entries(conversationId, { kinds?, limit?, before? })` — newest-first fork-aware history, including entries before resets/compactions; `before` is an exclusive entry ID.
- `ultimate.search(text, { conversationId?, limit? })` — case-sensitive substring over stored entry JSON, including pre-reset/pre-compaction history.
- `ultimate.taskGraph()` — live tasks and ownership graph.
- `ultimate.models()` — model metadata, without credentials or provider headers.
- `ultimate.agents()` — agent definitions, the profiles subagents and automations run with: each one's source (builtin, user, project), path, fields, and instructions, plus files that failed to parse. To change one, edit its file; for a built-in, write an override with the same name to `<project>/.ultimate/agents/` or `~/.ultimate/agents/`.
- `ultimate.doc(kind, conversationId?)` — exported conversation document or `pi.agent`/`pi.inbox`/`pi.live`/`pi.usage`; defaults to the calling conversation.

Facets can export `userActions: string[]` to reserve actions for the UI. `ultimate.action` rejects these with
`<extension>/<action> is a user-only action`; use the UI for project trust, secret changes, and provider login/logout.
Normal actions remain callable. This dispatch restriction is not a sandbox against arbitrary agent code.

Entry/search limits default to 100 and must be 1–1000. Pagination of raw entries uses the oldest returned entry ID as `before`. Other writes go through normal tools. Action side effects, like nested tool side effects, are not rolled back if the script fails or yields.

## Durable store

`store(key, value)` / `load(key)` use the conversation document `codemode.store` (rewindable, fork as-of). Values are loaded before every script. Store writes are saved only when the script finishes successfully; a yielded wait discards them. The document is exported in `docs` for SSE subscriptions.

**Crash window:** Pi Durable 1.0 has no result-transaction callback. Store writes use a separate `api.commit()` immediately before returning success. A crash between that commit and durable tool settlement retains the writes while the model may be told the script was **interrupted**. Do not treat store updates as atomic receipts of external side effects.

With `ULTIMATE_FAUX=1`, submit `codemode demo` to see nested read/bash progress and the final result without a model account.

## UI

`web.tsx` renders each `codemode` call: the script with highlighting (collapsed when long), the nested-call log (✓/✗, tool, arguments, duration; streamed while running, from `details.calls` when done), the text output, images, and the returned value as a JSON tree (`@/components/json-tree`). The Documents tab shows the shown conversation's `codemode.store` under Store, through the renderer `web.tsx` registers for it.
