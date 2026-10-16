---
name: integrate-ultimate
description: Integrate Ultimate into an existing project. First investigate the project and how its people work on it, then suggest a small set of project-specific extensions, surfaces, agents and settings, and build the chosen ones into <project>/.ultimate/. Use when someone wants to "use Ultimate in this project", "set up Ultimate here", asks what Ultimate could do for a repository, or wants a review team or a lander (checks and push on landing) set up for a project.
---

# Integrate Ultimate into a project

Ultimate is meant to be specialized per project. Built-ins give every project the same agent. A project's `.ultimate/` folder, committed with the repository, adds what only that project needs: settings, agents, skills, and extensions with tools, panels and full-screen surfaces. Everyone who starts `ultimate` in the folder then gets the specialized agent; onboarding asks once whether to use it.

Work in three phases. Do not build anything before the user has chosen.

## 1. Investigate (read-only)

Gather evidence, citing file:line, before forming opinions.

- **Identity:**
  - the remote and whether it is private, since that decides whether to push after building;
  - what the project is;
  - the stack and its real versions (manifests win over docs; READMEs and agent docs are often stale).
- **How it runs:**
  - the dev, build, test and lint commands and the dev server port;
  - deploy;
  - required secrets, by name only (never print or read values; read `.env` keys only by name).
- **The domain model:** what the project's "things" are (posts, services, tickets, datasets), where they live, their states, and how they are created and changed.
- **Existing agent assets:** `AGENTS.md`/`CLAUDE.md`, `.pi/skills/` (Ultimate loads these as-is), `.claude/`, prompts, and scripts that agents already drive. These encode the real workflow; reuse them and don't reinvent them.
- **How people actually work:**
  - `git log` subjects;
  - recent agent conversations or threads, if any (in Ultimate: `ultimate.projects()` and conversation search in codemode);
  - TODOs and docs.

  Note what they repeat by hand, what they check in a browser, and which steps cost money or are irreversible.

## 2. Suggest

Map the findings to Ultimate's building blocks:

| Need                                        | Building block                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| The agent should know project rules         | `AGENTS.md`/`CLAUDE.md` (already read), or a skill in `.ultimate/skills/`     |
| A recurring multi-step workflow             | a skill (`.pi/skills/` or `.ultimate/skills/`), driven from the conversation  |
| A specialist role                           | an agent definition in `.ultimate/agents/<name>.md`                           |
| Seeing and acting on the domain's things    | an extension with a **surface** (a full-screen app) or a panel                |
| A deterministic operation                   | an extension **action** or **tool** that reuses the project's scripts         |
| A long-running process (dev server, render) | a server facet that manages a child process and cleans up `onClose`           |
| An API key                                  | declare it with `secrets` and read it server-side only                        |
| Recurring work                              | `automations`                                                                 |
| Review by several models, one verdict       | a review team in `agents/` (see "Review team and lander")                     |
| Checks and a push on every landing          | `lander` settings, optionally a `lander` agent (see "Review team and lander") |
| Which built-ins are on                      | `.ultimate/settings.json` `extensions.enable`                                 |

Propose **2–4 ranked suggestions**, not a catalogue. For each, say what the user sees, what it reuses, and what it needs (secrets, processes, costs). Principles:

- **Reuse:** surfaces call the project's own scripts and skills; the agent does the judgment work in the conversation, and the surface shows state and offers one-click entry points.
- **Deliberate costs:** steps that cost money or are irreversible (paid APIs, deploys, publishing) are explicit, human-confirmed clicks.
- **Secrets stay server-side:** never in tool output, the transcript, or the browser.
- **Start small:** one or two surfaces that remove the biggest context switch beat a dashboard of everything.
- **Built-ins:** enable the useful ones. `self` and `instance` are for developing Ultimate itself; leave them off elsewhere.

Ask the user to choose, offering defaults. Ask only questions whose answers change what gets built.

## Review team and lander

Both work without setup: the shipped `reviewer` reviews alone on the parent's model, and `workspace submit` merges and
fast-forwards with no checks and no push. Ultimate's own clone is the working example: copy from its `.ultimate/agents/`
and `.ultimate/settings.json`, then adjust models and commands.
Worker reports and submissions state divergence from the task as given (agreements, approach, scope), or "None";
`workspace submit` requires that `divergence` string, and lander reports distinguish any additional changes.

- **Review team:** agent definitions, so it can live in `<project>/.ultimate/agents/` or, for every project, in
  `~/.ultimate/agents/` (a project's file wins by name). Override `reviewer` with a lead that lists `subagent` in
  `tools`, starts every `reviewer-*` definition in parallel and merges their reports without reviewing itself
  (`.ultimate/agents/reviewer.md`). Add one `reviewer-<name>.md` per reviewer, each pinned to a different model the
  user is logged in to (`reviewer-astra.md`, `reviewer-sol.md`). Details: "Review team" in
  `extensions/subagents/README.md`.
- **Lander:** checks and push are per project, in `<project>/.ultimate/settings.json` (read once the project is
  chosen): `"lander": { "checks": [...], "push": "origin" }` lists the project's own check commands in order (an array
  runs as a concurrent group) and the remote to push to; push only with the owner's consent. Add
  `isolates.worktree.setup` (for example the dependency install) when checks need it. To let the lander's model resolve
  conflicts and failing checks instead of only diagnosing them, add a `lander` definition with `onFailure: fix` and the
  tools it needs (`.ultimate/agents/lander.md`), per project or in `~/.ultimate/agents/`. Details:
  `extensions/workspaces/README.md`.

Paths above are relative to the Ultimate clone (`../..` from this skill). Definitions are reread on every start and
settings apply live; nothing needs a restart.

## 3. Build and verify

- **Files:** `.ultimate/settings.json`; `.ultimate/README.md`, a short explainer that onboarding shows; one folder per extension in `.ultimate/extensions/<name>/` (`server.ts`, `web.tsx`, `README.md`). Follow `extensions/README.md` in the Ultimate clone.
  - Extensions outside the clone import what built-ins import (`@/sdk`, `@/components/…`, clone packages), and nothing type-checks them.
  - Keep the project's own tooling (type check, lint, format) from scanning `.ultimate/`.
- **Verify against the real project**, not a copy of Ultimate. Use a temporary `HOME` with the project trusted (`~/.ultimate/trust.json`) and onboarding done, then run `node <clone>/bin/ultimate.ts <project> --port <free> --no-open`.
  - Check the extension info for load errors.
  - Call the actions.
  - Open the surfaces in a browser and take screenshots.
  - Never spend money or deploy while verifying.
- **Commit** in the project repository: push if it is private and the owner's policy is to push; ask first if it is public or shared.
- **Hand off:**
  - how to start it (`ultimate` in the folder);
  - what onboarding will ask;
  - what each surface does;
  - which secrets to add in the Secrets panel.
