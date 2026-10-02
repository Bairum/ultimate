# Onboarding

Onboarding remembers first-run completion and lets the browser choose a project's setup and configure extensions live.

This default-on built-in exports browser actions (no model tools):

- `status`: first-run state and project configuration, decision, and capped README.
- `firstRunDone`: records completion in the injected user home's `.ultimate/onboarding.json`.
- `decide { local }`: saves the project choice with Pi's `ProjectTrustStore` in `.ultimate` and reloads extensions and web facets.
- `setExtension { name, enabled, scope }`: updates user or project settings, preserving other keys. Project writes require a local decision.
- `adoptProjectSetup`: merges project enable/disable lists into user settings.
- `extensions`: discovered names, sources, effective enablement, deciding layers, and README first sentences, including project folders not yet selected.

Undecided projects use global configuration. Only a local decision enables project extension folders, extension settings, agents, and skills; other project settings remain readable. Settings and completion-marker writes use same-directory temporary files and atomic renames, with two-space JSON and a trailing newline. Project decisions, summaries, and deciding layers come through `ExtensionHost`; onboarding imports no core runtime modules.
