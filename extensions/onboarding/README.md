The first-run welcome, the ask-once project setup page, and the Extensions panel that turns extensions on and off live.

## UI

- **Welcome** (first run): what Ultimate is, what is on, the login state, how to start, and where the building blocks
  are. When no provider is logged in it opens the `models` login flow (`auth.login`). Closing it in any way calls
  `firstRunDone`, so it shows once per machine.
- **Project page** (a project with `.ultimate/` and no decision): what the setup adds (the built-ins its settings
  turn on or off, its own extensions, agents, and skills) beside its `.ultimate/README.md`, rendered as the explainer,
  and the choice "Use this project's setup" or "Use my global setup". It shows before the welcome. Escape defers it
  for the tab; until a choice is made the global setup is in use. The Extensions panel opens it again ("About this
  setup").
- **Extensions panel** (right-panel tab, palette "Extensions…"): the project decision with a way to change it,
  "Use this project's setup everywhere", and every extension, on and available, with its source, the layer that
  decided it, its README line, and a switch. Switches save to this project (when its setup is in use) or everywhere.
  Turning off `agent` or `onboarding` asks first, because the panel goes with them. Failures show on the row; the
  list follows system info, so a change shows once it is live.

The pages are dialogs: Escape or the close button dismisses them, focus moves into them and back to the composer.

## Actions

This default-on built-in exports browser actions (no model tools):

- `status`: first-run state; project configuration, decision, and capped README; and `adds`, the names of the
  project's `.ultimate/agents/*.md` (frontmatter `name`, else the file name) and `.ultimate/skills`, read even while
  undecided and never loaded.
- `firstRunDone`: records completion in the injected user home's `.ultimate/onboarding.json`.
- `decide { local }`: saves the project choice with Pi's `ProjectTrustStore` in `.ultimate` and reloads extensions and web facets.
- `setExtension { name, enabled, scope }`: updates user or project settings, preserving other keys. Project writes require a local decision.
- `adoptProjectSetup`: merges project enable/disable lists into user settings.
- `extensions`: discovered names, sources, effective enablement, deciding layers, and README first sentences, including project folders not yet selected.

Undecided projects use global configuration. Only a local decision enables project extension folders, extension settings, agents, and skills; other project settings remain readable. Settings and completion-marker writes use same-directory temporary files and atomic renames, with two-space JSON and a trailing newline. Project decisions, summaries, and deciding layers come through `ExtensionHost`; onboarding imports no core runtime modules.
