# Ultimate

Ultimate is a local coding agent with a web UI, built on Pi Durable (`@earendil-works/pi-durable`). It runs this
repository while it edits it: you are probably reading this as Ultimate, about to change yourself. Everything below
tells you which change reloads how, so the conversation you are in keeps running.

## How work is organised: a forest of conversation trees

A project is a forest of conversation trees, each tree like a history of commits.

- **Roots** each hold one line of work's idea, principles and standing decisions, and keep its tally: every landing
  from a root's tree leaves a note in it. Start a root deliberately (New → New root) or adopt a conversation with
  ⌘K "Make this a root". A fresh project's first conversation is its first root.
- **A branch** is a feature, a fix, an experiment. It is forked deliberately from a conversation in a tree at a point,
  starts from a brief aimed at its intent, and then works as if it were the only conversation.
  New branches from the root of the tree you are in. A branch is never a subagent.
- **Coordinators carry the work.** A branch plans, decides and verifies; subagents are for bounded execution and
  reconnaissance, and the lander is the final gate on main.
- **Zoom out when you need to.** Read any root or sibling with codemode `ultimate.entries(id)` and
  `ultimate.search()`; commits name the conversation that made them (`Ultimate-Conversation` trailer).
- **Talk across the tree without waking anyone.** `note` leaves context in another conversation for its next turn;
  `notify` tells you when another conversation finishes. A conversation that resumes after main moved gets a
  catch-up of what landed, overlaps first.
- **Conclude** a conversation when its work is done; it stays readable and can be resumed.
- **UI polish lands when the user says so.** For small look-and-feel work (an animation, a loading state, spacing,
  a card), keep a faux preview of the branch's checkout running (`instance start` with `faux: true`), give the user
  its URL, and iterate there: commit each round in the branch, but do not `workspace submit` until the user has
  clicked around and approved it. Larger UI features and anything with behaviour behind it land as usual.

`extensions/lineage/README.md` has the mechanics.

## Layers and how they reload

| Path                          | What lives there                                                                               | How a change goes live                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extensions/<name>/web.tsx`   | UI of an extension: slots, panels, surfaces, tool and entry renderers, commands                | Vite hot reload, instantly, without a page reload. A broken facet shows an error card; the rest keeps running.                                                                                         |
| `extensions/<name>/server.ts` | Agent behaviour: system prompt, tools, hooks (Pi Durable extensions)                           | Reinstalled on save. Running tool calls finish on the old code; the next call uses the new code.                                                                                                       |
| `web/`                        | The web core: surface host with primitives, SDK (`web/src/sdk`), transcript, composer, palette | Vite hot reload, instantly. Nothing else to do.                                                                                                                                                        |
| `agents/`                     | Subagent definitions (Markdown with frontmatter)                                               | Read at each use.                                                                                                                                                                                      |
| `server/`, `shared/`          | Core plumbing: harness, storage, API, Vite hookup                                              | Call the `restart` tool. A new process boots and type-checks next to the old one; if it fails you get the error and the old process keeps running. If it succeeds, the run resumes in the new process. |
| `bin/`                        | The supervisor                                                                                 | Only a human restart (`pnpm start`) applies it. Keep it tiny and change it rarely.                                                                                                                     |

Put behaviour in `extensions/` rather than `server/` whenever you can: it reloads without a restart.
A surface is a full-screen app the user switches to (header, ⌘K, `mod+1…9`); the conversation itself is the built-in
`agent` surface, and a project's apps go in `<project>/.ultimate/extensions/` (see "Surfaces" in the guide).
New UI is a new extension folder, not a change to `web/`: follow [extensions/README.md](extensions/README.md), the
guide to writing extensions, and copy the closest existing one (`status-line`, `coding-tools`).
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
others load; see [Events](extensions/README.md#events).

## Discovery and settings

Discovery is clone built-ins, then `~/.ultimate/`, then `<project>/.ultimate/`; later names replace earlier ones.
Skills load from clone `skills/`, then Pi's defaults, then `~/.ultimate/skills/`, then
`<project>/.ultimate/skills/`, with later names winning.
Every built-in is on by default, including `faux` (inert unless `ULTIMATE_FAUX=1`), `lineage` (conversation trees: roots, branches, notes), `parallel` (web tools; reads `secrets`), `classify` (Jev typed judgments; reads `secrets`), `phase` (working phases; requires `classify`), and `tailscale` (remote access; inert on faux servers, and only user settings can turn it off for good). Settings layer defaults, `~/.ultimate/settings.json`, then `<project>/.ultimate/settings.json`:
`extensions.enable` and `extensions.disable` are name arrays, later layers win, and changes apply live without a
restart. User/project extension folders are on by default too; `disable` turns off any extension. Unknown names
produce a notice. `summaryModel` (`"provider/id[:thinking]"`, default `openai/gpt-6-luna:medium`; project over user)
picks the model for automatic titles, summaries and reply assessments; set it in either file or with
the "Summary model…" command, and it applies to the next request.
User config is independent of `ULTIMATE_HOME`. This repository's `.ultimate/settings.json` holds only its isolate setup
and lander checks.

A project's `.ultimate/` applies only once it is chosen: its `extensions/`, the project `extensions` settings layer,
`agents/`, and `skills/` load only when the project decision is local. Decisions are kept per project path with Pi's
`ProjectTrustStore` in `~/.ultimate/trust.json`, and a linked git worktree shares its main checkout's; undecided behaves like global and is reported in system info
(`project.decision`). Every `.ultimate/settings.json` key (`defaultSurface`, `isolates`, …) goes through the gated
`host.projectSettings()`; onboarding reads the file only to show what choosing the project would bring. The `onboarding` extension asks once and its Extensions panel changes the choice live. Resources you add to a
project's `.ultimate/` stay unloaded until that project is local; tests seed the decision in their temporary home.

## Inspecting yourself

Use `codemode` to compose dependent or parallel `tools.*` calls and filter results before they enter your context. Its read-only `ultimate.*` API is the way to inspect yourself: system/build, extension facets and load errors, conversations, stored entries and search (including before compactions/resets), task graph, models, and exported documents. Use ordinary tools for writes and single simple calls. `store`/`load` persist conversation-scoped values; see `extensions/codemode/README.md` for interruption semantics.

## Durability

Conversations, tool calls, subagents, and documents are committed to SQLite (`$ULTIMATE_HOME/state.sqlite`, default
`~/.ultimate/projects/<name>-<hash>/`) before anything is shown. A restart or crash resumes the run from its last checkpoint. A tool declared
`replay: "safe"` reruns after a crash; any other interrupted tool reports "interrupted" to the model. Make a tool
replay-safe only if a rerun cannot do harm, and store decisions in `api.memo()`.
Every `replay: 'safe'` declaration needs a preceding reason comment, enforced by `ultimate/replay-safe-reason`.

Each folder keeps its own conversations in that central projects directory. Homes describe themselves with `project.json` and debounced `conversations.json`; `host.projects()` (or `ultimate.projects()` in codemode) lists these manifests and live supervisor URLs without opening another project's SQLite.

The web SDK's `useUiState(key, initial)` stores shared durable UI state; scroll positions and drafts stay in the browser.
The host owns `ultimate.ui` on the root conversation, persisted in SQLite and copied as of the fork entry.

## Running the server

- `pnpm install`, then `pnpm start` runs the supervisor on Node 26. It owns the public TCP port and single-instance lock, prints the URL and opens it as a Chrome app window (`http://ultimate.localhost:<port>`, a tab without a Chrome-family browser); `--no-open` or `ULTIMATE_NO_OPEN=1` disables opening.
- Run `pnpm link --global` once in the clone, then `cd ~/Projects/app && ultimate`. `ultimate [dir] [--port N] [--no-open]` starts in that project, or opens a window of it when it already runs; `pnpm start` in the clone uses the clone as the project.
- Project config belongs in `<project>/.ultimate/`: extensions, agents, skills, and optional `settings.json` (JSON object; `defaultSurface` selects the preferred surface). Discovery is built-in, user `~/.ultimate/`, then project config; later names win. User config is independent of `ULTIMATE_HOME`.
- Server facets can export `actions`, a map of async `(args, ctx)` functions called by `POST /api/extensions/:name/actions/:action` with `{ args, conversationId? }`, returning `{ result }`. `ctx` has `host`, optional `conversationId`, `signal`, and `exec(command, args, { cwd?, timeout? })`; exec uses the project cwd, no shell, a 1 MiB output cap and a maximum 30 second timeout.
- `pnpm dev` runs the core standalone; the `restart` tool requires `pnpm start`.
- Call `restart` after editing `server/` or `shared/`, never for `web/`, `extensions/`, or `agents/`. `POST /api/restart` accepts the same swap; reconnect to events to observe the new generation. The supervisor type-checks and prepares a new child without storage, then waits for the old harness to close before opening the new one and resuming work. Failed checks/preparation keep the old child serving.
- A crashed child restarts with backoff. After three failed boots the supervisor serves diagnostics and retries on changes in `server/`, `shared/`, or `extensions/`.
- Binds only `127.0.0.1`; `--port` or `ULTIMATE_PORT` overrides selection, otherwise the supervisor chooses the first free port from `4747`.
- `ULTIMATE_HOME` overrides state storage; the default is `~/.ultimate/projects/<basename>-<sha256(projectRoot) first 8 hex>/`. Different projects can run concurrently. Never run two storage owners on the same home.
- `ULTIMATE_GENERATION` defaults to `1` and labels the process in system info.
- `ULTIMATE_FAUX=1` uses a looping demo provider without tokens; its tools edit only a scratch file in the home.
- Pi's models, settings, auth, skills, and context loaders are shared with `~/.pi/agent`; the `models` extension logs in to providers.
- `pnpm check` checks format/lint/types; `pnpm test` runs the fast in-process faux tests with temporary homes (target under 10 s); `pnpm test:e2e` runs `test/e2e`, the tests that spawn real supervisors and instances; `pnpm eval` runs the real-model agent evals in `evals/` and ends with their cost. There are no browser tests: UI is verified on a faux instance with screenshot or browser.
- `tsconfig.swap.json` is the server-only type-check gate for swaps.
- `tsconfig.json` (server, tests, tooling) references `tsconfig.web.json` (browser: `web/src`, `extensions/**/*.tsx`).
  `pnpm check` type-checks both; with plain `tsc`, run `tsc -b`.
- The standalone server shuts down on SIGINT/SIGTERM; reopening resumes durable work.

## Working in a git worktree

Run `git worktree add ../ultimate-preview -b preview`, then `cd ../ultimate-preview`, `pnpm install`, and `pnpm start --no-open` to run that worktree's code. Each project path gets its own default state home (a hash of the path), storage and supervisor locks, first free port from 4747, and Vite cache inside its home; explicit home or port overrides must remain distinct. The global `ultimate` command runs the clone it was linked from, so use `pnpm start` inside the worktree instead.

Start a subagent with `isolate: "worktree"` (the worker default) to give its tools a separate checkout; verify its commits, then `land` them or `discard` the checkout while keeping its branch. For Ultimate itself, `instance start` with `subagent: <child id>` previews that child's code on a free port with a separate temporary home; stop the preview afterwards.

### Main-agent final integration

A top-level conversation created with New isolated conversation works in its own worktree.
`workspace status` shows its tip and the original checkout's tip.
Read worker reports and diffs; rerun checks only for missing or thin evidence, reported failures, changes crossing
workers, `server/` or `shared/` changes, or surprises in the diff, then land and call `workspace submit`.
The lander is the final gate: it runs every configured check (here `pnpm check`, then `pnpm test`, `pnpm test:e2e` and `pnpm eval` in parallel) on the merged result
and reports back, landed or not, with findings.
It fixes small failures when the project configures it to; on success it fast-forwards the branch and pushes to
`lander.push` (here `origin`), so keep working while it runs.
Its progress shows live on the submit tool card, with expandable steps, and its report as an outcome card, both in
the submitting conversation; the source's "Lander · <target>" conversation, pinned at the top of the sidebar, keeps
the full log and shows as working in the Agents tab while it lands. It runs the `lander` agent
definition: here `.ultimate/agents/lander.md` with `onFailure: fix`, so a conflict or a twice-failing check is
resolved and committed by its model, every check runs again, and only then does it land and push. Talk to it in its
conversation about the queue and recent landings.
`workspace land` is the synchronous alternative: it only fast-forwards, refuses moved or diverged targets, and never
rebases or pushes. Unrelated dirty files in the original checkout block neither.
For `server/` or `shared/` changes, an authorized `restart` works once the running clone is clean at the landed commit.

### Standing permission to push this repository

The user authorizes the top-level agent to commit verified changes, land them, and push the destination branch
(normally `main`) to this repository's GitHub remote, `origin` (`HazAT/ultimate`), without asking again. This permission
applies to this repository whether public or private, not to other repositories. `workspace submit` covers this: the
lander pushes after its checks because `lander.push` is set. After a synchronous `workspace land`, which never pushes,
push the landed branch explicitly (for example, `git -C /home/haza/Projects/ultimate push origin main`). Subagents commit and report; only the top-level agent pushes after verification and integration.

Use normal, non-force pushes only. Remote advancement or a non-fast-forward rejection is normal: fetch, inspect the
incoming log and diff, and merge non-destructively in an isolated workspace, preserving both histories. Rerun checks,
then land and push normally without asking again. Stop and report ambiguous conflicts,
failing checks, security concerns, or a situation requiring a force push or history rewrite—not ordinary remote
advancement. Do not push secrets or unrelated unverified work.
This standing permission does not authorize releases, publishing, deployments, or GitHub issue/PR changes.

## Conventions

- Commits made through Ultimate's bash tool carry `Ultimate-Conversation: <id>`; find the conversation behind a commit with `git log --format=%(trailers:key=Ultimate-Conversation)`.
- Pi is the role model: minimal, readable, malleable. Prefer platform features and existing dependencies; justify every
  new dependency in its commit message.
- `pnpm check` enforces import boundaries; see `lint/ultimate.ts` and `vite.config.ts`.
- Plain TypeScript, ESM, Node 26 runs `.ts` directly: erasable syntax only (no enums, namespaces, or parameter
  properties), relative imports end in `.ts`.
- Core server/web contracts live in `shared/protocol.ts`; extension-local types live with their extension.
- Pin `@earendil-works/*` packages to exact versions; Pi Durable is experimental.
- Checks: `pnpm check` (format, lint, types) and the tests covering your change must pass before a commit; the lander runs every suite. Keep `pnpm test` fast: no real-time waits, no spawned processes (those go to `test/e2e`), and fix or delete a flaky test rather than skipping it or raising its timeout. Per-test timeouts fail lint (`ultimate/no-test-timeout`); `test/e2e` is exempt.
- Every user-visible result is designed, not dumped: status and outcomes (a subagent report, a landing, a failure) get a
  renderer that matches the existing cards (see `extensions/subagents/messages.tsx`, `extensions/workspaces/log.tsx`),
  never plain Markdown in a message. Look at the running app and recent screenshots first, write the expected look into
  task descriptions, and check a worker's screenshots against it before accepting.

## Review quality

A swallowed error needs a reason comment explaining why ignoring it is correct; `ultimate/no-silent-catch` enforces this for empty catch blocks and empty or `undefined`-returning `.catch` handlers.

Reject slop and jargon: keep code and explanations direct, minimal, and grounded in evidence. No backward-compatibility
shims or speculative fallbacks; move forward and update callers. Tests must exercise meaningful behaviour and failure
cases, not inflate coverage or merely restate the implementation.

## Subagents

Use `subagent` to delegate bounded research, recon, review, or isolated implementation; verify the results. Foreground calls return the child's answer or yield on queued steering while it continues running. All new children survive the parent's stop; use explicit child stop. Undelivered answers steer the active run at its next tool-round boundary, or start a run when idle. Start, message/steer, wait, stop, and list all use child conversation IDs. Children cannot delegate by default. Only definitions explicitly listing `subagent` in `tools` retain the tool and
extension, subject to the parent's tool subset; they follow their assigned role, not the generic coordinator flow.

Definitions live in `agents/`, `~/.ultimate/agents/`, and the project root's `.ultimate/agents/` (later wins by name), and are reread at every start; the Agents tab lists them. See `extensions/subagents/README.md` for frontmatter. Shipped models inherit the parent's model.

Review goes through one `reviewer`: here a Luna lead (`.ultimate/agents/reviewer.md`) that starts every `reviewer-*`
definition in parallel and returns one merged verdict. Add a reviewer by adding a `reviewer-<name>.md`.

## Borrowed from Pi

- `server/http.ts` — adapted HTTP dispatcher, not exported; prevents early provider stream termination. undici in package.json exists only for this file. Drop when Pi exports configureHttpDispatcher and applyHttpProxySettings; keep the MIT notice until then.
- `pnpm-workspace.yaml` — registers patches/@earendil-works__pi-durable@1.2.0.patch, patching sanitizeOutput to remove whole CSI/OSC/control strings while keeping numeric SGR, adding transactional input-placement hooks, marking entries placed from input submissions (input: true) so extensions can distinguish requests from user-role writes, and recording the requested thinkingLevel on each response as pi-agent-core does, and patches/@earendil-works__pi-claude-code@0.1.0.patch, rebuilding replay cache markers to stay within Claude's four-block limit. Drop each patch when upstream ships the corresponding fix; pnpm errors when a versioned patch no longer matches.
- `test/claude-code-cache.test.ts` — internal imports exercise the pi-claude-code replay cache patch registered in pnpm-workspace.yaml. Drop this coupling and the patch when upstream rebuilds cache breakpoints within Claude's four-block limit.
- `extensions/lineage/catchup.ts` — uses the patched transactional beforeInput hook to place catch-up notes before inputs. Drop the patch when Pi ships input-placement hooks.
- `test/ansi-output.test.ts` — internal import exercises the installed sanitizer patch. Drop when Pi exports the sanitizer and OutputBuffer or ships equivalent sanitizer tests.
- `extensions/coding-tools/diff.tsx` — internal untyped details.patch/details.diff formats drive the diff renderer. Drop when Pi exports structured diff rows for rendering.
- `extensions/prompt/server.ts` — tool guidance adapted from unexported prompt contributions, not Ultimate's personality. Drop when Pi exports buildSystemPromptSections and the per-tool system prompt contributions.
- `web/src/app/model.ts` — internal trailing <harness> text block duplicates diagnostics and is stripped for display. Drop when Pi exports a diagnostic-free tool-result content accessor.
- `web/src/sdk/format.ts` — copied formatTokens helper, not exported. Drop when Pi exports formatTokens.
- `web/src/sdk/events.ts` — adapted Pi event bus using browser-safe sets instead of node:events, with Pi's exported EventBus type and handler-error semantics. Drop when Pi ships a browser-safe bus.
- `extensions/coding-tools/web.tsx` — internal bash exit_code diagnostic message drives exitOf and untyped details.patch/details.diff drive Edit. Drop when Pi exports structured bash outcomes and structured diff rows for rendering.
- `extensions/self/web.tsx` — internal remove-all pi.system entry immediately precedes a reordered re-add, hidden here. Drop when Pi exposes prompt reorder metadata instead of requiring entry-sequence inference.
- `extensions/subagents/server.ts` — internal ToolTaskInput.assistant locates the calling assistant for history forks. Drop when ToolExecutionApi exposes the calling assistant entry ID.

On a Pi upgrade, run `rg "Pi upstream:"` and recheck each marked item against the new version; test/pi-upstream.test.ts checks that every tracked marker matches the installed package version and its path appears in this list, and every backticked path in this list is tracked and contains a marker.
Delete copies and patches that Pi now exports or fixes, then update the remaining markers and this list after verification.

## Reference

- Pi Durable README and examples: `node_modules/@earendil-works/pi-durable/README.md`, upstream
  https://github.com/earendil-works/pi/tree/main/packages/durable
- The durable coding agent this host follows: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable
