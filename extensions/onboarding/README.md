The two-page first run, the project question, and the Extensions panel that turns extensions on and off live.

## UI

- **First run, page 1 "Get ready"**: a checklist of what Ultimate needs, read live from `useModels()` and the shown
  conversation: "Connect a model provider" (done once any provider but faux is logged in; Connect runs the `models`
  login, `auth.login`) and "Choose a model" (done once the conversation's model is available; Choose runs `model.pick`).
  Continue waits for both. When the login or the picker closes, or a step gets done, focus moves to the next action.
- **First run, page 2 "Recommended extensions"**: `recommended` in `pages.tsx`, one entry per extension with a line of
  a few words, as checkboxes, all checked; `needs` checks another with it (`automations` needs `subagents`) and
  unchecking that one unchecks it. A folder with a `.ultimate/` and no decision adds "Use this project's setup", on,
  with what the setup brings as chips (its own extensions, the built-ins its settings turn on and off, folders that
  replace a built-in, agents, skills) and its `.ultimate/README.md` behind "What's in it". Continue applies it all with
  `applyFirstRun`; the app switches live. Skip, Escape, and the close button keep the defaults, record the first run,
  and defer the project question for the tab.
- **Project card** (outside the first run, a project with `.ultimate/` and no decision): "Use this project's setup?"
  with the same chips and disclosure, and "Use it" or "Not now", which both remember the choice. Escape defers it for
  the tab; until a choice is made the global setup is in use. The Extensions panel opens it again ("About this setup").
- **Extensions panel** (right-panel tab, palette "Extensions…"): the project decision with a way to change it,
  "Use this project's setup everywhere", and every extension, on and available, with its source, the layer that
  decided it, its README line, and a switch. Switches save to this project (when its setup is in use) or everywhere.
  Turning off `agent` or `onboarding` asks first, because the panel goes with them. Failures show on the row; the
  list follows system info, so a change shows once it is live.

The pages are dialogs: Escape or the close button dismisses them, focus moves into them and back to the composer.
The first-run splash fades into page 1, already open beneath it.

## Actions

This default-on built-in exports browser actions (no model tools):

- `status`: first-run state; project configuration, decision, and capped README; and `adds`, what the project's setup
  brings, read even while undecided and never loaded: the names of its `.ultimate/agents/*.md` (frontmatter `name`,
  else the file name), `.ultimate/skills`, and extension folders (`extensions`, and `replaces` for those named like a
  built-in), and the `enable` and `disable` lists of its settings.
- `firstRunDone`: records completion in the injected user home's `.ultimate/onboarding.json`.
- `applyFirstRun { extensions, local? }`: `extensions` maps names to booleans; true adds the name to the user's
  `extensions.enable` and drops it from `disable`, false drops it from `enable`. Records the first run, then applies
  the settings and, when `local` is given, the project decision with one reload.
- `decide { local }`: saves the project choice with Pi's `ProjectTrustStore` in `.ultimate` and reloads extensions and web facets.
- `setExtension { name, enabled, scope }`: updates user or project settings, preserving other keys. Project writes require a local decision.
- `adoptProjectSetup`: merges project enable/disable lists into user settings.
- `extensions`: discovered names, sources, effective enablement, deciding layers, and README first sentences, including project folders not yet selected.

Undecided projects use global configuration. Only a local decision enables project extension folders, extension settings, agents, and skills; other project settings remain readable. Settings and completion-marker writes use same-directory temporary files and atomic renames, with two-space JSON and a trailing newline. Project decisions, summaries, and deciding layers come through `ExtensionHost`; onboarding imports no core runtime modules.
