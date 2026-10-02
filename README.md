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
pnpm start          # first free port from 4747 opens in your browser
pnpm link --global  # once, in this clone
cd ~/Projects/app && ultimate
```

- No `pi` login yet? Open the command palette (`Ctrl+K`, `⌘K` on macOS) → "Log in to a provider". Logins are shared
  with `pi`, and so is logging out.
- On another machine: `ssh -L 4747:127.0.0.1:4747 <host>`, then open `http://127.0.0.1:4747`. Ultimate only listens on
  loopback.
- `ultimate [dir] [--port N] [--no-open]` defaults to the current directory. Ultimate's source stays in the clone; tools and the root conversation work in the project.
- State lives in `~/.ultimate/projects/<basename>-<sha256(projectRoot) first 8 hex>/`; `ULTIMATE_HOME` overrides it. One supervisor per project, so projects can run concurrently. `--port` or `ULTIMATE_PORT` wins; otherwise the first free port from 4747 is used.
- Extensions and agents load from the clone, `~/.ultimate/`, and `<project>/.ultimate/` (later names win). Skills add user/project `.ultimate/skills` to Pi's loader. These config folders are independent of state storage. Optional `.ultimate/settings.json` passes through in system info; `defaultSurface` names the preferred surface.
- The first start in the clone migrates the legacy `~/.ultimate/state.sqlite` and screenshots to its project state directory, without moving user config.
- Extension server facets may export `actions = { name: async (args, ctx) => result }`. Call `POST /api/extensions/:name/actions/:action` with `{ args, conversationId? }` to get `{ result }`; `ctx` provides `host`, `signal`, and `exec(command, args, { cwd?, timeout? })` (project cwd, no shell, bounded output, 30 second maximum).

## What to try

- Ask it anything about this repository; watch tool calls, diffs, and thinking stream in.
- "Build a small extension that …" — it reads [extensions/README.md](extensions/README.md), writes
  `extensions/<name>/web.tsx`, and the UI hot-reloads in front of you. The status-line clock was its first one.
- "Take a screenshot of yourself and tell me what looks off" — it can see and drive its own UI.
- "Delegate to a scout: …" — subagents run as their own conversations (Agents tab, `open #id`).
- "Use codemode to check which of your extensions failed to load" — one sandboxed script over its own runtime.
- Change something in `server/` and ask it to `restart`: a new process boots and type-checks next to the old one, and the
  conversation carries on in the new generation. A failed boot rolls back.
- Press `Ctrl+Alt+B` for the right panel: Info (machine, process, storage, build, extensions, skills), Agents, Tasks,
  and the codemode Store, each a tab.

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
