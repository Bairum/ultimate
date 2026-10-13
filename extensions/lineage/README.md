A project is one tree of conversations: a root that holds the idea, and branches forked from any conversation at any entry, each starting from a brief aimed at its intent.

- **Branch** (⌘K "Branch…", or action `branch` `{ from?, at?, prompt, isolated?, model?, thinkingLevel? }` → `{ id }`)
  forks the source at `at` (default: its latest entry) as an ownerless conversation in the project root, optionally
  isolated in its own worktree. The background task `lineage.brief` asks the branch's model to write a brief of the
  source context aimed at the prompt, places it as a `pi.reset` with `data.lineage = { from, at }`, then submits the
  prompt. The branch's model sees only the system prompt, the brief and what follows; history above stays readable.
  The source gets a display-only `lineage.branched` entry. Doc `lineage.branch` on the branch holds
  `{ from, at, intent, status: 'briefing' | 'ready' | 'failed', error? }`; action `retry` `{ id }` restarts a failed
  brief.
- **Root**: doc `lineage.root` on conversation 1 (`{ root? }`, unset means 1). Action `root` `{ id }` (⌘K "Make this
  the root") moves it; `info` returns `{ root }`.
- **Notes**: the `note` tool `{ to: id | 'root', text }` writes a `lineage.note` entry in the target without waking it;
  its model reads `Note from #N: …` with its next input. Other extensions call `leaveNote(host, to, text, source?)`;
  `source: { source: 'lander' }` renders as a landing.
- **Prompt**: the `lineage` section tells each top-level conversation where it sits in the tree and how to read the
  others (codemode `ultimate.entries(id)`, `ultimate.search()`).
- **Compaction**: top-level conversations summarize with their own model and a lineage focus (root: idea, principles,
  standing decisions, tally of landings and branches; branch: intent and progress). Subagents keep Pi's default.
