# Codemode

Run an async JavaScript function body in a fresh QuickJS/WASM sandbox. Only injected functions can access the host. Prefer it for dependent or parallel tool calls, filtering large outputs, and inspecting Ultimate; use ordinary tools for a single simple operation.

`await tools.<name>(args)` calls the conversation's currently resolved tools, except codemode. Nested calls share the parent durable task (no separate durable tool task), bypass `beforeTool`/`afterTool` hooks, and capture their output privately. Failures reject with the tool's error text. Tools declaring an `outputSchema` and returning `structuredContent` resolve to that JSON; other tools resolve to text. Durable 1.0 does not declare these optional structured fields itself.

`text(value)`, console methods, `image(data)`, and the return value produce model-visible output. Nested-call completion lines stream to `pi.live`; final details contain `{ calls: [{ name, args, status, ms }], value?, error? }`. Script failures preserve output and QuickJS's `codemode.js:<line>` stack. Interrupted scripts are not replayed: Durable returns an interrupted result with the committed partial log. Ordinary nested side effects are never rolled back.

The first line may be `// @options: {"timeout_ms":30000,"max_output_tokens":2000}`. Default timeout is 60 seconds, text output budget is 10,000 estimated tokens, and VM heap limit is 256 MiB. Conversation abort and sandbox deadlines cancel nested work through its context.

## Read-only introspection

Only inside codemode (not standalone model tools):

- `ultimate.system()` — machine, process, persistence, resources, build identity.
- `ultimate.uiState()` — durable root-conversation UI state, so you can see what the user is looking at.
- `ultimate.extensions()` — folders, facets, tools, sections, documents, load errors.
- `ultimate.conversations()` — all stored conversation identities and ownership edges.
- `ultimate.entries(conversationId, { kinds?, limit?, before? })` — newest-first fork-aware history, including entries before resets/compactions; `before` is an exclusive entry ID.
- `ultimate.search(text, { conversationId?, limit? })` — case-sensitive substring over stored entry JSON, including pre-reset/pre-compaction history.
- `ultimate.taskGraph()` — live tasks and ownership graph.
- `ultimate.models()` — model metadata, without credentials or provider headers.
- `ultimate.doc(kind, conversationId?)` — exported conversation document or `pi.agent`/`pi.inbox`/`pi.live`/`pi.usage`; defaults to the calling conversation.

Entry/search limits default to 100 and must be 1–1000. Pagination of raw entries uses the oldest returned entry ID as `before`. Writes go through normal tools, never `ultimate.*`.

## Durable store

`store(key, value)` / `load(key)` use the conversation document `codemode.store` (rewindable, fork as-of). Values are loaded before every script. Only successful scripts apply their store writes. The document is exported in `docs` for SSE subscriptions.

**Crash window:** Pi Durable 1.0 has no result-transaction callback. Store writes use a separate `api.commit()` immediately before returning success. A crash between that commit and durable tool settlement retains the writes while the model may be told the script was **interrupted**. Do not treat store updates as atomic receipts of external side effects.

With `ULTIMATE_FAUX=1`, submit `codemode demo` to see nested read/bash progress and the final result without a model account.
