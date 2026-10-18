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

## Inspecting yourself

Use `codemode` to compose dependent or parallel `tools.*` calls and filter results before they enter your context. Its `ultimate.*` API is the way to inspect yourself: system/build, extension facets and load errors, conversations, stored entries and search (including before compactions/resets), task graph, models, and exported documents. `ultimate.action(extension, action, args?)` is its one write: call an extension action on behalf of this conversation. Use ordinary tools for other writes and single simple calls. `store`/`load` persist conversation-scoped values; see `extensions/codemode/README.md` for interruption semantics.
