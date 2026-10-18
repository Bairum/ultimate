A read-only `debug` tool for finding out why something did or did not happen in the running Ultimate, and for following one chain of work across extensions. It is deferred: only agents whose definition names it get it (@ultimate, in `agents/ultimate.md`).

One tool, one `call` discriminator; every answer is compact text, one line per row, newest first, with relative ages (`40s`, `12m`, `3h`, `2d`) and at most about 16K characters:

- `events { events?, since?, limit? }` — durable events from `host.eventLog.recent`: age, event id, name, data (cut at 160 characters) and the trace context it was emitted in (`trace=… conversation=… call=…`). `events` filters by name (`workspaces.landed`), `since` is an exclusive event id. Default 20.
- `reactors {}` — each reactor with its event names, cursor, lag (matching events after the cursor), `running` or `stopped`, and its last failure with the event it failed on.
- `catalogue {}` — each extension API with its provider (`MISSING` when none), needs and wants, then the missing APIs and dependency cycles.
- `trace { trace?, conversation?, since?, limit? }` — recorded service, action, reactor and tool calls (`kind  caller → name  ms  ok|failed: error  args=…`) with their trace, conversation and entry ids; `since` is an ISO time. With `trace` set, the whole tree of that trace in start order, children indented under their parents. Default 50.
- `apis {}` — every enabled extension with an `api.ts` and the first sentence of its opening doc comment; `api { name }` returns that file's source. Unknown names fail with the list of known ones.

A typical path: find the event or call that should have led somewhere, take its `trace=` id, and read `trace { trace }`.

The same data is in codemode as `ultimate.catalogue()`, `ultimate.trace()`, `ultimate.traceTree()`, `ultimate.apis()` and `ultimate.api(name)`; both read `api.ts` files through `lib/api-files.ts`.
