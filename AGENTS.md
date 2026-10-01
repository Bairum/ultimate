# Ultimate

Ultimate is a local coding agent with a web UI, built on Pi Durable (`@earendil-works/pi-durable`). It runs this
repository while it edits it: you are probably reading this as Ultimate, about to change yourself. Everything below
tells you which change reloads how, so the conversation you are in keeps running.

## Layers and how they reload

| Path | What lives there | How a change goes live |
| --- | --- | --- |
| `web/` | The UI (React, Tailwind, shadcn components we own) | Vite hot reload, instantly. Nothing else to do. |
| `extensions/` | Agent behaviour: system prompt, tools, hooks (Pi Durable extensions) | Reinstalled on save. Running tool calls finish on the old code; the next call uses the new code. |
| `agents/` | Subagent definitions (Markdown with frontmatter) | Read at each use. |
| `server/`, `shared/` | Core plumbing: harness, storage, API, login, Vite hookup | Call the `restart` tool. A new process boots and type-checks next to the old one; if it fails you get the error and the old process keeps running. If it succeeds, the run resumes in the new process. |
| `bin/` | The supervisor | Only a human restart (`pnpm start`) applies it. Keep it tiny and change it rarely. |

Put behaviour in `extensions/` rather than `server/` whenever you can: it reloads without a restart.

## Durability

Conversations, tool calls, subagents, and documents are committed to SQLite (`$ULTIMATE_HOME/state.sqlite`, default
`~/.ultimate`) before anything is shown. A restart or crash resumes the run from its last checkpoint. A tool declared
`replay: "safe"` reruns after a crash; any other interrupted tool reports "interrupted" to the model. Make a tool
replay-safe only if a rerun cannot do harm, and store decisions in `api.memo()`.

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
