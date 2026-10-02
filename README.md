# Ultimate

Your sidekick: a coding agent that can do anything a coding agent does, and that builds applications with you, live,
in a web UI, while it learns everything about the application you are building together.

Built on [Pi Durable](https://earendil.com/posts/pi-durable/): the conversation, every tool call, and every subagent are
committed to SQLite before anything is shown, so Ultimate can rewrite its own UI, extensions, and core without losing its
place.

## Why

- **One sidekick, always there.** Ultimate is one long-running conversation, not a fresh session per task. Compaction
  keeps it going, so it accumulates what it learns about your project and your application.
- **Clone it and make it yours.** Everything except a small core is an extension: tools, prompt sections, the status
  line, panels, whole app surfaces. Ultimate can read and change all of it, including itself, while it runs. Ask for a
  change and watch it hot-reload in front of you.
- **Run it in your project.** A `.ultimate/` folder in your project tailors Ultimate to it, like Pi's `.pi/`: project
  extensions, subagents that know your codebase, skills, and surfaces.
- **Build applications on the fly.** A surface is a full-screen composition of extensions: the agent interface you start
  with is one; a GitHub triage app, a dashboard, or an internal tool can be another. Ultimate provides the primitives
  (shadcn components, Tailwind, durable state, server actions, the docked agent), builds the surface with you, and you
  switch to it while it is being built. Or hook an agent interface tailored to your application into your existing
  project.
- **Lean and malleable.** Like Pi and Pi Durable, the core stays as small as possible and everything else is replaceable.

You do not have to build your application inside Ultimate, but you can build a lot with it out of the box.

## Start

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
- On another machine: `ssh -L 4747:127.0.0.1:4747 <host>`, then open `http://127.0.0.1:4747`. Ultimate only listens on
  loopback.

### In your project

`ultimate [dir] [--port N] [--no-open]` starts Ultimate for a project (default: the current directory). Ultimate's own
source stays in the clone; the tools and the conversation work in your project.

- **`.ultimate/` in your project** tailors it: `extensions/`, `agents/`, `skills/`, and an optional `settings.json`
  (`defaultSurface` picks the surface to open). Ultimate also reads your personal `~/.ultimate/` the same way. Lookup
  order is the clone, then `~/.ultimate/`, then the project; later names win.
- **State** lives in `~/.ultimate/projects/<name>-<hash>/` (`ULTIMATE_HOME` overrides it), so each project keeps its
  own conversation, and several projects can run at once on their own ports (the first free one from 4747).
- **Actions** let an extension's UI call its server code: `export const actions = { … }` in `server.ts`, then
  `useAction(extension, name, args)` in `web.tsx`. See [extensions/README.md](extensions/README.md).

## Surfaces

A surface is a full-screen app made of extensions: the **Agent** surface is the conversation you start with; another
can be anything you build. Switch with the menu on the ULTIMATE brand, `⌘K` → "Switch to …", or `mod+1…9`. The agent
stays docked on every surface and knows which one you are looking at, and the choice is durable: reloads, other tabs,
and restarts land on the same view.

**Example: GitHub Triage.** This repository's own `.ultimate/extensions/github-triage/` was built by Ultimate itself
through its UI: open issues and pull requests of any repository via the `gh` CLI, filters and search, details with the
body and comments, and buttons that hand an item to the docked agent (summarize, suggest labels, draft a reply). The
agent can only propose; the UI writes labels or comments after you confirm, and only to repositories listed in
`githubTriage.writableRepos` in `.ultimate/settings.json`. If `gh` is missing or logged out, it shows how to set it up.

## What to try

- Ask it anything about this repository; watch tool calls, diffs, and thinking stream in.
- "Build a surface for …" — a whole app with its UI, server actions, and the agent docked beside it; switch to it while
  it is being built. The Triage surface was its first.
- "Build a small extension that …" — it reads [extensions/README.md](extensions/README.md), writes
  `extensions/<name>/web.tsx`, and the UI hot-reloads in front of you. The status-line clock was its first one.
- "Take a screenshot of yourself and tell me what looks off" — it can see and drive its own UI.
- "Delegate to a scout: …" — subagents run as their own conversations (Agents tab, `open #id`).
- "Use codemode to check which of your extensions failed to load" — one sandboxed script over its own runtime.
- Change something in `server/` and ask it to `restart`: a new process boots and type-checks next to the old one, and the
  conversation carries on in the new generation. A failed boot rolls back.
- Press `Ctrl+Alt+B` for the right panel: Info (machine, process, storage, build, extensions, skills), Agents, Tasks,
  and Documents (the plan, the codemode store, and every other extension document), each a tab.

The conversation is one long-running thread by design; compaction keeps it going.

## How it is put together

[AGENTS.md](AGENTS.md) is Ultimate's guide to itself: which path holds what, how each layer reloads, and the
conventions. Everything that is not core plumbing is an extension folder with a `server.ts` (agent) and/or `web.tsx`
(UI) facet; [extensions/README.md](extensions/README.md) is the guide to writing them.

## Develop

```bash
pnpm dev                          # the server alone, without the supervisor
ULTIMATE_FAUX=1 pnpm start        # a scripted demo model, no tokens
pnpm check                        # format, lint, types
pnpm test                         # integration tests with the faux model
```

## License

[MIT](LICENSE). The repository is private for now.
