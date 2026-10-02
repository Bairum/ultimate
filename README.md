# Ultimate

A local coding agent with a web UI that builds itself while it runs. Built on
[Pi Durable](https://earendil.com/posts/pi-durable/): the conversation, every tool call, and every subagent are committed
to SQLite before anything is shown, so Ultimate can rewrite its own UI, extensions, and core without losing its place.

## Start

Needs Node 26 and pnpm, and a `pi` login (Ultimate shares `~/.pi/agent`: credentials, models, settings, skills). The
screenshot and browser tools need a Chromium: `/usr/bin/chromium`, Google Chrome, Playwright's cached Chromium, or
`ULTIMATE_CHROMIUM=<path>`.

```bash
pnpm install
pnpm start          # http://127.0.0.1:4747 opens in your browser
```

- No `pi` login yet? Open the command palette (`Ctrl+K`, `⌘K` on macOS) → "Log in to a provider". Logins are shared
  with `pi`, and so is logging out.
- On another machine: `ssh -L 4747:127.0.0.1:4747 <host>`, then open `http://127.0.0.1:4747`. Ultimate only listens on
  loopback.
- State lives in `~/.ultimate` (`ULTIMATE_HOME`); the port is `ULTIMATE_PORT`. One Ultimate per home.

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
