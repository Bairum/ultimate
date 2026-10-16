The two-page first run, the project question, and the Extensions panel that turns extensions on and off live.

## UI

- **First run, page 1 "Get ready"**: a checklist of what Ultimate needs, read live from `useModels()` and the shown
  conversation, and announced as it changes: "Connect a model provider" (done once any provider but faux is logged
  in, or while the conversation runs on the faux demo model, "Demo provider · faux"; Connect runs the `models` login,
  `auth.login`) and "Choose a model" (done once the conversation's model is available; Choose runs `model.pick`).
  Continue waits for both. When the login or the picker closes, or a step gets done, focus moves to the next action.
- **First run, page 2 "Recommended extensions"**: `recommended` in `pages.tsx`, one entry per extension with a line of a
  few words, as checkboxes, checked unless `~/.ultimate/settings.json` disables it; `needs` checks another with it
  (`automations` needs `subagents`) and unchecking that one unchecks it; a needed extension outside the list turns on
  with it (`parallel`, web search, needs `secrets`). A folder with a `.ultimate/` and no decision adds "Use this
  project's setup" (on to start with only in Ultimate's own clone), with what the setup brings as chips (its own
  extensions, the built-ins its settings turn on and off, folders that replace a built-in, agents, skills) and its
  `.ultimate/README.md` behind "What's in it". While it is on, the rows its settings decide show "on in this project" or
  "off in this project", locked; the user's own choice stays underneath and is what Continue saves. Back keeps the
  choices. Continue applies it all with `applyFirstRun`, and the app switches live; with `parallel` on and
  `PARALLEL_API_KEY` missing, the Secrets panel then opens at that key. Skip, Escape, and the close button (ignored
  while Continue applies) keep the defaults, record the first run, and defer the project question for the tab.
- **Project card** (a project with `.ultimate/` and no decision): "Use this project's setup?" with the same chips and
  disclosure, and "Use it" or "Keep global", which both remember the choice. It never opens by itself: while the
  decision is open, a quiet "project setup" entry on the right of the status line opens it, and so does the Extensions
  panel ("About this setup"). Escape and the close button ("Decide later") just close it; until a choice is made the
  global setup is in use.
- **Git card** (a project that cannot have isolated conversations yet, per the `workspaces` `isolation` action): a quiet
  "set up git" entry in the status line opens "Set up Git for this folder?", and so does the start page's disabled
  Isolated switch. It says why (no repository, no first commit, no branch) and what Git brings. An empty folder gets
  "Set up Git", the `workspaces` `setupGit` action (`git init` where needed and an empty first commit); a folder with
  files gets "Ask the agent", a request to the shown conversation to write a `.gitignore` and make the first commit
  without secrets, dependencies or build output, adding no remote. "Not now", Escape and the close button just close it.
  The entry reads `isolation` again after the card acts and whenever the shown conversation finishes a run.
- **Extensions panel** (right-panel tab, palette "Extensions…"): the project decision with a way to change it,
  "Use this project's setup everywhere", and every extension, on and available, with its source, the layer that
  decided it, its README line, and a switch. Switches save to this project (when its setup is in use) or everywhere.
  Turning off `agent` or `onboarding` asks first, because the panel goes with them. Failures show on the row; the
  list follows system info, so a change shows once it is live.

An automated browser (`navigator.webdriver`, as in the agent's `browser` and `screenshot` tools) does not get the first
run.

The pages are dialogs: Escape or the close button dismisses them, focus moves into them and back to the composer.
The first-run splash fades into page 1, already open beneath it.

## Actions

This default-on built-in exports browser actions (no model tools):

- `status`: first-run state; project configuration, decision, and capped README; `user`, the `enable` and `disable`
  lists of `~/.ultimate/settings.json`; and `adds`, what the project's setup brings, read even while undecided and
  never loaded: the names of its `.ultimate/agents/*.md` (frontmatter `name`, else the file name), `.ultimate/skills`,
  and extension folders (`extensions`, and `replaces` for those named like a built-in), and the `enable` and `disable`
  lists of its settings.
- `firstRunDone`: records completion in the injected user home's `.ultimate/onboarding.json`.
- `applyFirstRun { extensions, local? }`: `extensions` maps non-empty names to booleans; true adds the name to the
  user's `extensions.enable` and drops it from `disable`, false drops it from `enable`. Records the first run, then
  applies the settings and, when `local` is given, the project decision with one reload.
- `decide { local }`: saves the project choice with Pi's `ProjectTrustStore` in `.ultimate` and reloads extensions and web facets.
  A linked git worktree reads and saves its main checkout's choice, so new worktrees of a decided project never ask.
- `setExtension { name, enabled, scope }`: updates user or project settings, preserving other keys. Project writes require a local decision.
- `adoptProjectSetup`: merges project enable/disable lists into user settings.
- `extensions`: discovered names, sources, effective enablement, deciding layers, and README first sentences, including project folders not yet selected.

Undecided projects use global configuration. Only a local decision enables project extension folders, extension settings, agents, and skills; other project settings remain readable. Settings and completion-marker writes use same-directory temporary files and atomic renames, with two-space JSON and a trailing newline; `settings.ts` holds that writer, which the conversations extension reuses for `summaryModel`. Project decisions, summaries, and deciding layers come through `ExtensionHost`; onboarding imports no core runtime modules.
