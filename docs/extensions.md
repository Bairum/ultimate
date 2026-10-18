## Extension mechanics

Each extension is a folder `extensions/<name>/`: `server.ts` exports a Durable extension with that name
(or a factory receiving `ExtensionHost`, which provides `ultimateRoot` (the clone), `projectRoot` (your work), state/home paths, models/settings, build and system inspection, conversation summaries, harness access, shared resources, and lifecycle hooks), `web.tsx` is its optional browser facet
(`defineWebExtension` from `@/sdk`), and `README.md` describes it. The server facet may export `docs`, an array of conversation document tokens;
subscribe with `/api/events?conversation=<id>&docs=<kind>,<kind>` for `doc` snapshots and `docOps` batches.
The Documents tab shows each exported kind through the renderer a web facet registers (`documents: [{ kind, title, component }]`), or as JSON.
Local imported modules reload with the facet. Failed loads leave the previous version installed.

Extensions coordinate ephemeral happenings with `host.events` (Pi's process-local bus) or browser `events`/`useEvent`
from `@/sdk`; these are separate, unbridged buses. Use `<extension>:<event>` channels, reserve `ultimate:*` for core,
and keep durable state in documents. `useReady()` becomes true once the initial facets settle and a system snapshot
arrives, stays true across hot reloads, and exposes failed facet names. Overlays render as facets install, even while
others load; see [Events](../extensions/README.md#events).

## Durable events

For "this happened" that other extensions act on or people read later, use durable events instead of the bus. Define
a token once with `defineEvent<Data>('<extension>.<event>', { version? })` from `shared/events.ts` (browser-safe) and:

- `host.emit(tx, Event, data)` appends it inside your commit, so it exists exactly when your state change does.
- `host.react(name, [Event, …], (tx, event) => …)` runs the handler once per event, oldest first: those emitted before
  it started, then each new one, serially per name (`<extension>/<name>`). The cursor advances in the handler's
  transaction, so writes through `tx` happen exactly once across crashes, reloads and failures; side effects outside
  `tx` (files, processes, network) are at least once. A throw rolls back the handler and the cursor, records the
  failure, and retries the event on the next matching commit or harness open. Reactors run while the harness is open
  and stop with their facet; a reloaded facet registering the same name continues from the cursor.
- `host.eventLog.recent({ events?, since?, limit })` reads the newest first as plain copies; `host.eventLog.reactors()`
  shows each reactor's cursor, lag and last failure. In the browser, `useEvents({ events?, limit })` from `@/sdk` streams
  the root's feed of the latest 100 events.

Each distinct `host.notice` message of a facet is also recorded as an `ultimate.notice` event while storage is open.
Keep events few and small: they are history.

## Extension APIs

A service one extension offers another is a typed token, `defineApi<Service>()('name')` from
`shared/extension-api.ts`, kept in the provider's `api.ts` (browser-safe, so web code can import it too). The provider
calls `host.implement(Token, value)`; consumers call `host.need(Token)` for a hard dependency or `host.want(Token)` for
an optional one. Both return a handle that resolves the current provider on every member access, so a handle taken at
setup survives provider reloads. Every method call goes through one internal `call`, the place tracing hooks in.
`need` throws `<ext> needs <api>, which no enabled extension provides` while nothing provides it (at setup it records
the dependency instead, since the provider may load later, and the missing provider becomes an extension diagnostic);
`want` returns undefined. `host.catalogue()` and codemode's `ultimate.catalogue()` list each API's provider, needs
and wants, the missing providers and the dependency cycles (each a sorted group of extensions that depend on each
other in a cycle). `host.provide`/`host.use` are the untyped predecessors and
share the provider table.

Pick the channel by what crosses it: services for calls between extensions, documents for durable state, durable
events (above) for "this happened", actions for the UI and user boundary.

## Inspecting yourself

Use `codemode` to compose dependent or parallel `tools.*` calls and filter results before they enter your context. Its `ultimate.*` API is the way to inspect yourself: system/build, extension facets and load errors, conversations, stored entries and search (including before compactions/resets), the extension API catalogue, task graph, models, and exported documents. `ultimate.action(extension, action, args?)` is its one write: call an extension action on behalf of this conversation. Use ordinary tools for other writes and single simple calls. `store`/`load` persist conversation-scoped values; see `extensions/codemode/README.md` for interruption semantics.
