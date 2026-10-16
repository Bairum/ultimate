# Ultimate

A coding agent you specialize for the project you work on. Start it in your repository and it is Pi's coding agent in a
web UI. Then build what this project needs into it, such as custom tools, panels, subagents, skills, or whole screens,
and keep them in the project's `.ultimate/` folder. Everyone who works on the project boots the same specialized agent,
and it still feels familiar in every project, because the core is always the same.

Built on [Pi Durable](https://earendil.com/posts/pi-durable/): the conversation, every tool call, and every subagent are
committed to SQLite before anything is shown, so Ultimate can rewrite its own UI, extensions, and core without losing its
place.

## How to use it

- **Specialize it for your project.** Working on a web shop? Ask Ultimate for what makes work on that shop easier: a
  tool that queries the staging catalog, a panel that shows the order pipeline, a reviewer that knows your checkout
  rules, a skill for releases. It writes them as extensions, agents, and skills into `<project>/.ultimate/`, and they
  hot-reload while you talk.
- **Commit them with the project.** `.ultimate/` is part of the repository, so everyone who opens the project gets the
  same specialized agent. Ultimate asks once before it uses a project's setup, because project extensions run code.
- **One familiar core everywhere.** The conversation, Pi's tools, the model and login, and the way it works are the same
  in every project; only the project's own pieces differ. Your personal additions live in `~/.ultimate/` and follow you
  to every project.
- **Everything on, switch off what you don't need.** A fresh Ultimate is Pi's coding agent with every built-in:
  subagents, plans, documents, automations, remote access and the rest ship in the clone and are on by default; turn any
  of them off per machine or per project (see "Building blocks" below).
- **A forest of conversation trees.** Each root holds one line of work's idea and keeps a tally of what landed;
  branch a feature or fix from any conversation at any point, and it starts from a brief aimed at its intent.
  Conversations run for a long time: compaction keeps them going, so they accumulate what they learn.
- **You can build whole applications in it, too.** A surface is a full-screen app next to the docked agent.
  The point is an agent shaped for the project you work on.
- **Lean and malleable.** Like Pi and Pi Durable, the core stays as small as possible and everything else is
  replaceable, including Ultimate itself: it runs this repository and can change its own code while you talk.

## Start

By default you get Pi's coding agent in a web UI: read, write, edit, bash, codemode, and browser debugging tools,
with the conversation, model and thinking controls, login, and footer, plus every other built-in building block.

Needs Node 26 and pnpm, and a `pi` login (Ultimate shares `~/.pi/agent`: credentials, models, settings, skills). The
screenshot and browser tools need a Chromium: `/usr/bin/chromium`, Google Chrome, Playwright's cached Chromium, or
`ULTIMATE_CHROMIUM=<path>`.

```bash
pnpm install
pnpm start          # Ultimate on its own repository; opens http://127.0.0.1:4747
pnpm link --global  # once, in this clone, to get the `ultimate` command
cd ~/Projects/app && ultimate
```

- No `pi` login yet? Open the command palette (`Ctrl+K`, `⌘K` on macOS) → "Log in to a provider". Logins are shared
  with `pi`, and so is logging out.
- **First start** on a machine shows two short pages: a live checklist (log in to a provider, choose a model), then
  the recommended extensions as checkboxes.
- **A folder with its own `.ultimate/`** asks once: its setup or your global one. Its extensions, agents, and skills
  stay off until you choose it; on the first start the question is part of the second page.
- **The Extensions panel** (right panel, or `Ctrl+K` → "Extensions…") lists every extension and turns it on or off
  live, for this project or everywhere, and can change the project choice.
- On another machine: `ssh -L 4747:127.0.0.1:4747 <host>`, then open `http://127.0.0.1:4747`. Ultimate only listens on
  loopback.

### Terminal status

`pnpm start` / `ultimate` shows a compact live terminal dashboard: the public URL, supervisor/core lifecycle,
core generation and PID, embedded Vite readiness, registered extension services, and the last event. Routine
Vite/HMR output updates the dashboard instead of scrolling; warnings and errors remain in scrollback. Redirected
output is plain text with no dashboard escape sequences. Detailed, timestamped JSON lines (including routine
output and diagnostics) are appended to `<state home>/supervisor.log`; this file is not automatically rotated.
A log-write failure warns once and does not stop supervision.

Services are status reports, not separate processes. Automations reports `ready · durable scheduler` when the
harness opens; this does not claim that all runs are idle. Process topology and durable scheduling are unchanged.
Supervisor changes require a **manual stop and restart with `pnpm start`**; a core swap does not reload `bin/`.

### In your project

`ultimate [dir] [--port N] [--no-open]` starts Ultimate for a project (default: the current directory) and opens it
as its own chromeless window in a Chrome-family browser (`http://ultimate.localhost:<port>`), or a tab when there is
none. Running it again for a running project opens another window instead. Ultimate's own source stays in the clone;
the tools and the conversation work in your project.

- **`.ultimate/` in your project** tailors it: `extensions/`, `agents/`, `skills/`, and an optional `settings.json`
  (`defaultSurface` picks the surface to open). Ultimate also reads your personal `~/.ultimate/` the same way. Lookup
  order is the clone, then `~/.ultimate/`, then the project; later names win.
- **State** lives in `~/.ultimate/projects/<name>-<hash>/` (`ULTIMATE_HOME` overrides it), so each project keeps its
  own conversations, and several projects can run at once on their own ports (the first free one from 4747).
  All project homes are in one central place, `~/.ultimate/projects/`; Ultimate can list other projects and their
  conversations with `ultimate.projects()` in codemode, including their URL when running.
- **Actions** let an extension's UI call its server code: `export const actions = { … }` in `server.ts`, then
  `useAction(extension, name, args)` in `web.tsx`. See [extensions/README.md](extensions/README.md).

## Building blocks

Built-ins live in the clone's `extensions/`, and every one is on by default; `faux` stays inert outside demo mode,
and `tailscale` exposes Ultimate only to your own Tailscale login. Each folder's README describes the building block.

Turn them off in `~/.ultimate/settings.json` for this machine or `<project>/.ultimate/settings.json` for this project:

```json
{ "extensions": { "disable": ["tailscale", "claude-code"] } }
```

Settings layer defaults → machine → project; later layers win, and `extensions.enable` turns one back on.
Changes apply live, with no restart. User and project extension folders are on by default too: adding the folder
is the opt-in.

## Surfaces

A surface is a full-screen app made of extensions: the **Agent** surface is the conversation you start with; another
can be anything you build. Switch in the title bar, `⌘K` → "Switch to …", or `mod+1…9`. The agent
stays docked on every surface and knows which one you are looking at, and the choice is durable: reloads, other tabs,
and restarts land on the same view. The `surfaces` extension tells the agent which surface you are viewing, and
`documents` provides the Documents tab; surface UI contributions themselves work without either.

## What to try

- Ask it anything about this repository; watch tool calls, diffs, and thinking stream in.
- "Build a surface for …" — a whole app with its UI, server actions, and the agent docked beside it; switch to it while
  it is being built.
- "Build a small extension that …" — it reads [extensions/README.md](extensions/README.md), writes
  `extensions/<name>/web.tsx`, and the UI hot-reloads in front of you.
- "Take a screenshot of yourself and tell me what looks off" — it can see and drive its own UI.
- "Delegate to a worker: …" — subagents run as their own conversations (Agents tab, `open #id`).
- "Use codemode to check which of your extensions failed to load" — one sandboxed script over its own runtime.
- Change something in `server/` and ask it to `restart`: a new process boots and type-checks next to the old one, and the
  conversation carries on in the new generation. A failed boot rolls back.
- Press `Ctrl+Alt+B` for the right panel: Info (machine, process, storage, build, extensions, skills), Agents, Tasks,
  Documents (the plan, the codemode store, and every other extension document), Workspaces, Extensions and more, each
  a tab.
- Hover a message and choose "Branch from here" to fork the conversation at that point.

## How it is put together

[AGENTS.md](AGENTS.md) is Ultimate's guide to itself: which path holds what, how each layer reloads, and the
conventions. Everything that is not core plumbing is an extension folder with a `server.ts` (agent) and/or `web.tsx`
(UI) facet; [extensions/README.md](extensions/README.md) is the guide to writing them.

## Develop

```bash
pnpm dev                          # the server alone, without the supervisor
ULTIMATE_FAUX=1 pnpm start        # a scripted demo model, no tokens
pnpm check                        # format, lint, types
pnpm test                         # fast in-process tests with the faux model
pnpm test:e2e                     # tests that spawn real supervisors and instances
pnpm eval                         # real-model agent evals, ending with their cost
```

## License

[MIT](LICENSE).
