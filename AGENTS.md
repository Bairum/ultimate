# Ultimate

Ultimate is a local coding agent with a web UI, built on Pi Durable (`@earendil-works/pi-durable`). It runs this
repository while it edits it: you are probably reading this as Ultimate, about to change yourself. Everything below
tells you which change reloads how, so the conversation you are in keeps running.

## Layers and how they reload

| Path                          | What lives there                                                                               | How a change goes live                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extensions/<name>/web.tsx`   | UI of an extension: slots, panels, surfaces, tool and entry renderers, commands                | Vite hot reload, instantly, without a page reload. A broken facet shows an error card; the rest keeps running.                                                                                         |
| `extensions/<name>/server.ts` | Agent behaviour: system prompt, tools, hooks (Pi Durable extensions)                           | Reinstalled on save. Running tool calls finish on the old code; the next call uses the new code.                                                                                                       |
| `web/`                        | The web core: surface host with primitives, SDK (`web/src/sdk`), transcript, composer, palette | Vite hot reload, instantly. Nothing else to do.                                                                                                                                                        |
| `agents/`                     | Subagent definitions (Markdown with frontmatter)                                               | Read at each use.                                                                                                                                                                                      |
| `server/`, `shared/`          | Core plumbing: harness, storage, API, login, Vite hookup                                       | Call the `restart` tool. A new process boots and type-checks next to the old one; if it fails you get the error and the old process keeps running. If it succeeds, the run resumes in the new process. |
| `bin/`                        | The supervisor                                                                                 | Only a human restart (`pnpm start`) applies it. Keep it tiny and change it rarely.                                                                                                                     |

Put behaviour in `extensions/` rather than `server/` whenever you can: it reloads without a restart.
A surface is a full-screen app the user switches to (header, ⌘K, `mod+1…9`); the conversation itself is the built-in
`agent` surface, and a project's apps go in `<project>/.ultimate/extensions/` (see "Surfaces" in the guide).
New UI is a new extension folder, not a change to `web/`: follow [extensions/README.md](extensions/README.md), the
guide to writing extensions, and copy the closest existing one (`status-line`, `coding-tools`).
Each extension is a folder `extensions/<name>/`: `server.ts` exports a Durable extension with that name
(or a factory receiving `ExtensionHost`, which provides `ultimateRoot` (the clone), `projectRoot` (your work), state/home paths, models/settings, build and system inspection, harness access, shared resources, and lifecycle hooks), `web.tsx` is its optional browser facet
(`defineWebExtension` from `@/sdk`), and `README.md` describes it. The server facet may export `docs`, an array of conversation document tokens;
subscribe with `/api/events?conversation=<id>&docs=<kind>,<kind>` for `doc` snapshots and `docOps` batches.
Local imported modules reload with the facet. Failed loads leave the previous version installed.

## Inspecting yourself

Use `codemode` to compose dependent or parallel `tools.*` calls and filter results before they enter your context. Its read-only `ultimate.*` API is the way to inspect yourself: system/build, extension facets and load errors, conversations, stored entries and search (including before compactions/resets), task graph, models, and exported documents. Use ordinary tools for writes and single simple calls. `store`/`load` persist conversation-scoped values; see `extensions/codemode/README.md` for interruption semantics.

## Durability

Conversations, tool calls, subagents, and documents are committed to SQLite (`$ULTIMATE_HOME/state.sqlite`, default
`~/.ultimate/projects/<name>-<hash>/`) before anything is shown. A restart or crash resumes the run from its last checkpoint. A tool declared
`replay: "safe"` reruns after a crash; any other interrupted tool reports "interrupted" to the model. Make a tool
replay-safe only if a rerun cannot do harm, and store decisions in `api.memo()`.

The web SDK's `useUiState(key, initial)` stores shared durable UI state; scroll positions and drafts stay in the browser.
The host owns `ultimate.ui` on the root conversation, persisted in SQLite and copied as of the fork entry.

## Running the server

- `pnpm install`, then `pnpm start` runs the supervisor on Node 26. It owns the public TCP port and single-instance lock, prints and opens the URL (`--no-open` or `ULTIMATE_NO_OPEN=1` disables opening).
- Run `pnpm link --global` once in the clone, then `cd ~/Projects/app && ultimate`. `ultimate [dir] [--port N] [--no-open]` starts in that project; `pnpm start` in the clone uses the clone as the project.
- Project config belongs in `<project>/.ultimate/`: extensions, agents, skills, and optional `settings.json` (JSON object; `defaultSurface` selects the preferred surface). Discovery is built-in, user `~/.ultimate/`, then project config; later names win. User config is independent of `ULTIMATE_HOME`.
- Server facets can export `actions`, a map of async `(args, ctx)` functions called by `POST /api/extensions/:name/actions/:action` with `{ args, conversationId? }`, returning `{ result }`. `ctx` has `host`, optional `conversationId`, `signal`, and `exec(command, args, { cwd?, timeout? })`; exec uses the project cwd, no shell, a 1 MiB output cap and a maximum 30 second timeout.
- `pnpm dev` runs the core standalone; the `restart` tool requires `pnpm start`.
- Call `restart` after editing `server/` or `shared/`, never for `web/`, `extensions/`, or `agents/`. `POST /api/restart` accepts the same swap; reconnect to events to observe the new generation. The supervisor type-checks and prepares a new child without storage, then waits for the old harness to close before opening the new one and resuming work. Failed checks/preparation keep the old child serving.
- A crashed child restarts with backoff. After three failed boots the supervisor serves diagnostics and retries on changes in `server/`, `shared/`, or `extensions/`.
- Binds only `127.0.0.1`; `--port` or `ULTIMATE_PORT` overrides selection, otherwise the supervisor chooses the first free port from `4747`.
- `ULTIMATE_HOME` overrides state storage; the default is `~/.ultimate/projects/<basename>-<sha256(projectRoot) first 8 hex>/`. Different projects can run concurrently. Never run two storage owners on the same home.
- `ULTIMATE_GENERATION` defaults to `1` and labels the process in system info.
- `ULTIMATE_FAUX=1` uses a looping demo provider without tokens; its tools edit only a scratch file in the home.
- Pi's models, settings, auth, skills, and context loaders are shared with `~/.pi/agent`.
- `pnpm check` checks format/lint/types; `pnpm test` runs faux integration tests with temporary homes.
- `tsconfig.swap.json` is the server-only type-check gate for swaps.
- `tsconfig.json` (server, tests, tooling) references `tsconfig.web.json` (browser: `web/src`, `extensions/**/*.tsx`).
  `pnpm check` type-checks both; with plain `tsc`, run `tsc -b`.
- The standalone server shuts down on SIGINT/SIGTERM; reopening resumes durable work.

## Conventions

- Pi is the role model: minimal, readable, malleable. Prefer platform features and existing dependencies; justify every
  new dependency in its commit message.
- Plain TypeScript, ESM, Node 26 runs `.ts` directly: erasable syntax only (no enums, namespaces, or parameter
  properties), relative imports end in `.ts`.
- `shared/protocol.ts` is the only contract between server and web.
- Pin `@earendil-works/*` packages to exact versions; Pi Durable is experimental.
- Checks: `pnpm check` (format, lint, types) and `pnpm test` must pass before a commit.

## Subagents

Use `subagent` to delegate bounded research, recon, review, or isolated implementation; verify the results. Foreground calls return the child's answer. Background children survive the parent's stop; their answers steer the active run at its next tool-round boundary, or start a run when idle. Start, message/steer, wait, stop, and list all use child conversation IDs. No nested subagents.

Definitions live in `agents/`, `~/.ultimate/agents/`, and the project root's `.ultimate/agents/` (later wins by name), and are reread at every start; the Agents tab lists them. See `extensions/subagents/README.md` for frontmatter. Shipped models inherit the parent's model.

## Reference

- Pi Durable README and examples: `node_modules/@earendil-works/pi-durable/README.md`, upstream
  https://github.com/earendil-works/pi/tree/main/packages/durable
- The durable coding agent this host follows: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable
