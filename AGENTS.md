# Ultimate

Ultimate is a local coding agent with a web UI, built on Pi Durable (`@earendil-works/pi-durable`). It runs this
repository while it edits it: you are probably reading this as Ultimate, about to change yourself. Everything below
tells you which change reloads how, so the conversation you are in keeps running.

## Layers and how they reload

| Path                 | What lives there                                                     | How a change goes live                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web/`               | The UI (React, Tailwind, shadcn components we own)                   | Vite hot reload, instantly. Nothing else to do.                                                                                                                                                        |
| `extensions/`        | Agent behaviour: system prompt, tools, hooks (Pi Durable extensions) | Reinstalled on save. Running tool calls finish on the old code; the next call uses the new code.                                                                                                       |
| `agents/`            | Subagent definitions (Markdown with frontmatter)                     | Read at each use.                                                                                                                                                                                      |
| `server/`, `shared/` | Core plumbing: harness, storage, API, login, Vite hookup             | Call the `restart` tool. A new process boots and type-checks next to the old one; if it fails you get the error and the old process keeps running. If it succeeds, the run resumes in the new process. |
| `bin/`               | The supervisor                                                       | Only a human restart (`pnpm start`) applies it. Keep it tiny and change it rarely.                                                                                                                     |

Put behaviour in `extensions/` rather than `server/` whenever you can: it reloads without a restart.
Each extension is a folder `extensions/<name>/`: `server.ts` exports a Durable extension with that name
(or a factory receiving `{repoRoot, modelRuntime, settings}`), `web.tsx` is its optional browser facet,
and `README.md` describes it. The server facet may export `docs`, an array of conversation document tokens;
subscribe with `/api/events?conversation=<id>&docs=<kind>,<kind>` for `doc` snapshots and `docOps` batches.
Local imported modules reload with the facet. Failed loads leave the previous version installed.

## Durability

Conversations, tool calls, subagents, and documents are committed to SQLite (`$ULTIMATE_HOME/state.sqlite`, default
`~/.ultimate`) before anything is shown. A restart or crash resumes the run from its last checkpoint. A tool declared
`replay: "safe"` reruns after a crash; any other interrupted tool reports "interrupted" to the model. Make a tool
replay-safe only if a rerun cannot do harm, and store decisions in `api.memo()`.

## Running the server

- `pnpm install`, then `pnpm start` runs the supervisor on Node 26. It owns the public TCP port and single-instance lock, prints and opens the URL (`--no-open` or `ULTIMATE_NO_OPEN=1` disables opening).
- `pnpm dev` runs the core standalone; the `restart` tool requires `pnpm start`.
- Call `restart` after editing `server/` or `shared/`, never for `web/`, `extensions/`, or `agents/`. `POST /api/restart` accepts the same swap; reconnect to events to observe the new generation. The supervisor type-checks and prepares a new child without storage, then waits for the old harness to close before opening the new one and resuming work. Failed checks/preparation keep the old child serving.
- A crashed child restarts with backoff. After three failed boots the supervisor serves diagnostics and retries on changes in `server/`, `shared/`, or `extensions/`.
- Binds only `127.0.0.1`; `ULTIMATE_PORT` defaults to `4747`.
- `ULTIMATE_HOME` defaults to `~/.ultimate`; never run two storage owners on the same home.
- `ULTIMATE_GENERATION` defaults to `1` and labels the process in system info.
- `ULTIMATE_FAUX=1` uses a looping demo provider without tokens; its tools edit only a scratch file in the home.
- Pi's models, settings, auth, skills, and context loaders are shared with `~/.pi/agent`.
- `pnpm check` checks format/lint/types; `pnpm test` runs faux integration tests with temporary homes.
- `tsconfig.server.json` is the server-only type-check gate for swaps.
- The standalone server shuts down on SIGINT/SIGTERM; reopening resumes durable work.

## Conventions

- Pi is the role model: minimal, readable, malleable. Prefer platform features and existing dependencies; justify every
  new dependency in its commit message.
- Plain TypeScript, ESM, Node 26 runs `.ts` directly: erasable syntax only (no enums, namespaces, or parameter
  properties), relative imports end in `.ts`.
- `shared/protocol.ts` is the only contract between server and web.
- Pin `@earendil-works/*` packages to exact versions; Pi Durable is experimental.
- Checks: `pnpm check` (format, lint, types) and `pnpm test` must pass before a commit.

## Reference

- Pi Durable README and examples: `node_modules/@earendil-works/pi-durable/README.md`, upstream
  https://github.com/earendil-works/pi/tree/main/packages/durable
- The durable coding agent this host follows: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable
