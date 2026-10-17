Inline setup choices, the first-run prerequisites, and the Extensions panel that turns extensions on and off live.

## First run

The first run has only **Get ready**: connect a provider and choose an available model. The faux demo model also
counts as ready. Continue waits for both, starts onboarding with @ultimate through `onDone`, then records `firstRunDone`;
there is no second page. Escape or the close button records completion without changing settings. Closing returns
focus to the composer. An automated browser (`navigator.webdriver`) does not get this dialog.

## Onboarding with @ultimate

Continue on Get ready, or **Set up with @ultimate** on an empty root's Start here card, calls the user-only action
`start { root?, instructions? }` and opens @ultimate's standing conversation. An omitted root resolves to the shown
conversation's tree, or conversation 1. The optional focus is passed verbatim as instructions. The action submits a
quiet `onboarding.start` input with `{ root, instructions?, facts }`: project name/path, first-run state, undecided
project setup, Git isolation reason (if any), root id and emptiness. Model text names the event, lists those facts
and preserves the instructions. Request id `onboarding:<root>` ensures one input per root; repeated calls return
`{ id }` without sending again. The root conversation's `onboarding.starts` document maps roots to that standing id
so Start here can show **@ultimate is setting up this project · open** across reloads.

@ultimate greets, shows only applicable setup cards one at a time and waits for each choice, then reads the project
with the user able to steer. It writes the root's first tally through `seed_tally`, suggests at most three useful
project-specific agents, extensions or settings, and builds only what the user chooses. The first feature becomes a
coordinator through `branch`. **Read it here instead** keeps the old survey fallback; New root still surveys in place.
Under faux the same flow is scripted without model tokens (see `faux/README.md`).

## Setup cards

The deferred model tool `setup { card: 'extensions' | 'project' | 'git' }` is offered only to agent definitions that
name `setup`. It returns immediately with the current situation. It does not apply settings or wait on the user;
the agent should wait for an `onboarding.choice` input before continuing.

The tool renderer shows a quiet, transcript-width card:

- **Extensions:** recommended extensions as checkboxes, initially checked unless the user's settings disable them.
  `subagents`, `board`, `lineage` and `onboarding` stay checked and disabled with "needed by @ultimate": turning them
  off would cut off the agent and its setup cards. Dependencies are checked with their extension (`automations` needs
  `subagents`, `parallel` needs `secrets`).
  Continue applies user-global choices with `applyFirstRun`. Both checked and unchecked choices are saved explicitly;
  project settings can still override user settings.
- **Project:** "Use this project's setup?", chips showing its extensions, settings, agents and skills, and its
  `.ultimate/README.md` behind "What's in it". Use it / Keep global remembers the decision through `decide`.
  The tool refuses this card when there is no project setup or it is already decided.
- **Git:** why isolation is unavailable, and what Git brings. An empty folder gets Set up Git, through the
  workspaces user action `setupGit` (`git init` and an empty first commit). A folder with files gets
  Let @ultimate do it: the choice input asks the agent to write a fitting `.gitignore` and choose the first commit's
  contents without secrets, dependencies or generated output, adding no remote and pushing nothing. The tool refuses
  when the folder is already isolatable.

After applying a choice, the browser calls the user-only `choice { card, summary, toolCallId }` action in the same
conversation. It submits a typed input, kind `onboarding.choice`, with data `{ card, summary, toolCallId }` and model
text `Setup choice (<card>): <summary>`. Its stable request id `onboarding-choice:<toolCallId>` deduplicates double
clicks. A quiet input card displays the summary. The original tool card shows **Chosen: …**, with no buttons, derived
from the matching choice entry (or the current project/git status), so it stays settled after reload.

The status line keeps **project setup** while the project decision is open and **set up git** while isolation is
unavailable. Clicking posts "Help me decide whether to use this project's setup." or "Help me set up git for this
folder." to @ultimate through the Board, then opens the standing conversation returned by `addresses`. The Extensions
panel's About this setup and the start page's isolation shortcut route there too; they no longer open setup dialogs.
The Git status is read again whenever the shown conversation finishes a run, including an agent's first Git commit.

## Extensions panel

The right-panel tab (palette **Extensions…**) shows the project decision, a way to change it, Use this project's setup
everywhere, and every extension with its source, deciding layer, README line and switch. Switches save to this project
(when its setup is in use) or everywhere. Turning off `agent` or `onboarding` asks first, because the panel goes with
them. Failures show on the row; the list follows system info.

## Actions

This default-on built-in exports browser actions. Settings choices and completion actions are user-only: agents
cannot apply them through codemode `ultimate.action`.

- `start { root?, instructions? }`: starts the flow above once per root, returning `{ id }`; user-only.
- `status`: first-run state; project configuration, decision and README; the user's enable/disable lists; and `adds`,
  the project's agents, skills, extension folders, replacements and declared settings, inspected even while undecided.
- `firstRunDone`: records completion in the injected user home's `.ultimate/onboarding.json`.
- `applyFirstRun { extensions, local? }`: maps names to booleans, moving each name to user `extensions.enable` or
  `disable` and removing it from the opposite list. Records completion, then reloads; optional `local` also decides
  the project.
- `decide { local }`: saves the project choice through Pi's `ProjectTrustStore` and reloads extensions/web facets.
  Linked worktrees share their main checkout's choice.
- `choice { card, summary, toolCallId }`: the deduplicated typed input described above. Requires a conversation.
- `setExtension { name, enabled, scope }`: updates user or project settings, preserving other keys. Project writes
  require a local decision.
- `adoptProjectSetup`: merges project enable/disable lists into user settings.
- `extensions`: discovered names, sources, effective enablement, deciding layers and README first sentences.

Undecided projects use global configuration. Only a local decision enables project extension folders, settings,
agents and skills. Settings and completion-marker writes use same-directory temporary files and atomic renames,
with two-space JSON and a trailing newline; `settings.ts` holds the writer.
