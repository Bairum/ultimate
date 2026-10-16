A project is a forest of conversation trees. Each root keeps a non-agent tally of one line of work: prompts, each conversation's latest abstract, notes and landings. Branches do the work with that shared context.

- **Branch** (⌘K "Branch…", "Branch from here" on a message, or action `branch`
  `{ from, at?, prompt, images?, isolated?, model?, thinkingLevel? }` → `{ id }`). Every branch uses the same
  start page as New (model, Isolated, pasted images). It forks the source at `at` (default: its latest entry) as an
  ownerless conversation in the project root, optionally isolated in its own worktree. There is no brief or reset:
  it inherits the source context, then the durable `lineage.prompt` task submits the prompt and images as its first
  input. Doc `lineage.branch` holds `{ from, at, intent }`; `inputAt` is when the branch was asked for, not inherited
  activity. The fork happens before the tree root receives a model-visible `lineage.branched` prompt node
  `{ branch, at, intent, images?, from? }`, so the branch does not inherit its own prompt twice. `from` is present
  when the source is not the root; that source also gets a display-only marker.
- **Roots**: doc `lineage.roots` on conversation 1 (`{ roots }`, initially `[1]`) lists the roots. Clients stream it
  (`useRoots()` in `roots.tsx`). Root lookup walks owners and fork sources to a listed root; conversations outside
  those trees have none. Action `newRoot` `{ prompt, images?, isolated?, model?, thinkingLevel? }` → `{ id, root }`
  creates an empty tally, then its first branch; `id` is the branch to open. The root uses the chosen model or
  conversation 1's default. Creation emits `lineage:rooted` for the root and `lineage:branched` for the branch.
  Typing in a tally's composer starts a branch from its tip; the server refuses inputs to tallies.
  Action `root` `{ id }` (⌘K "Make this a root") adopts a top-level non-branch conversation or converts an existing
  root. With history, a durable `lineage.convert` task asks its own model for a genesis distillation and writes a
  `pi.reset` with `head: 'self'`, `data.lineage = { tally: true }` and model text `<tally from="#R/at">…</tally>`.
  Empty roots begin with an empty reset; converting a tally again does nothing. Roots with history from before
  tallies keep their ordinary composer and can run until converted. `info` returns `{ roots }`, and with `{ id }`
  also its `root` and `branch` when present.
- **Tally**: conversation-scoped doc `lineage.tally` (latest history) holds
  `{ abstracts: Record<string, number>, tokens: number, since?: number }`: each conversation's latest abstract entry,
  estimated model-visible context tokens, and the entry where the root became a tally. Forks start with an empty doc,
  not the source's bookkeeping. Tokens are recounted from active context after commits that append root entries,
  including resets and compaction. The root composer status shows the estimate as "Tally · … tokens".
  `lineage.abstract` entries hold `{ conversation, at, text, title?, feature? }`, with `at` pointing to the answer
  summarized. Each new abstract omits the previous one from model context through an `edits` omit; storage stays
  append-only. The transcript hides superseded abstracts and shows the latest as a card with a `#N/at` breadcrumb.
- **Notes**: `note` `{ to: id | 'root', text }` writes a `lineage.note` without waking the target; `'root'` resolves
  the caller's tree root. Its model reads `Note from #N: …` with its next input, or a future branch inherits it from
  the tally. Note cards use the mellow yellow `--note` theme token. `ConversationRef` names conversations by feature,
  else title, then `#N`; model text keeps bare ids. Other extensions call `leaveNote(host, to, text, source?)`;
  `'root'` needs `source.from` and errors if it has no root. Successful landings leave a note in the submitter's root
  (unless it is that root or has none), with `source: 'lander'`, `sha`, `target`, `commits`, `paths`, `divergence` and
  `at`. Text includes the submitter's `#N/at` breadcrumb and `Diverged: …`, including "None"; the landing card shows
  divergence too (up to 10 commits and 8 changed paths).
- **Notify**: `notify` `{ id, wake? }` starts `lineage.notify` in the caller. It waits until the target and its
  subagents are idle, then delivers `#id finished · <title>` with its last own answer (≤1500 chars), not an inherited
  source answer. `wake` (default true) submits a follow-up placed as `lineage.finished`; `wake: false` leaves a note
  with `source: 'finished'`. Request id
  `lineage:notify:<target>:<task>` deduplicates delivery; calling again for the same id aborts the pending task.
- **Catch-up on resume**: `lineage.seen` `{ main?, at?, tally? }` tracks the target commit and last accounted-for root
  entry. Branch creation seeds `tally` to the root tip before its own prompt node. Older conversations without it
  start from `lineage.tally.since`. On an idle resume, the transactional `GenerationTask.beforeInput` hook builds
  "Meanwhile in #R's tree": latest model-visible abstracts (preferred over prompts), prompts without an abstract,
  landings with divergence and breadcrumbs, notes, and any new tally distillation. It excludes the caller's own
  activity. Within about 6000 tokens it keeps the newest material in full, collapsing older conversations to one-line
  status with a pointer to `ultimate.entries(root)`; no model call runs in input placement.
  The same note then lists up to 30 new target commits, overlaps first (workspace diff against merge-base, or the
  conversation's own edit/write calls in a shared checkout), with conversation trailers and an isolate's behind count.
  No new tally material or commits means no note; mid-run inputs do not trigger catch-up. The local Pi Durable patch
  commits the `lineage.note` (`source: 'main'`), seen baselines and input atomically, with the note before the input
  in transcript and context. Tallies take no inputs and get no resume catch-up.
- **Prompt**: roots and subagents get no lineage section. Branches are told their origin and intent, tree root and
  inherited tally contents, and how to follow `#conversation/entry` breadcrumbs with `ultimate.entries(id)` and
  `ultimate.search()`. Other top-level conversations get their own id and lookup guidance. No list of roots changes
  the prompt cache.
- **Compaction**: manual compaction reshapes a tally without deleting history. Its own model keeps the idea,
  principles, standing decisions and each conversation's id, prompt, outcome, divergence, commits and breadcrumbs,
  merging superseded detail. Branch compaction focuses on intent and progress; subagents keep Pi's default.

Other extensions use `host.use<LineageService>('lineage')` (`server.ts`): `rootOf(id, ctx)` resolves tree membership,
`leaveNote(to, text, source?)` writes without waking, and `branchOf(id, ctx)` returns `{ root, intent? }` for top-level
non-root conversations in a tree (undefined for roots, owned conversations and outsiders).
`abstract(tx, id, { text, at, title?, feature? })` appends to that root and updates its abstract map in the caller's
transaction, before its first table write because it reads conversation records; it is a no-op wherever `branchOf`
is undefined. The conversations summarizer uses this to publish an abstract after each completed exchange.

New, "Branch…" and "Branch from here" open the start page (`start.tsx`) in `conversation.overlay`, with the
conversation beneath inert. It shows New's Branch / New root tabs, source and quoted branch point above the
new-conversation composer. Its URL (`?new`, `?new=<from>`, `?new=<from>.<at>`) survives reload; Back or Esc closes it,
switching conversations closes it, and each start point keeps its draft. Sending opens the new branch and the page
fades into its first message. There is no briefing overlay or retry action. Old stored brief resets still render;
a genesis reset instead shows a collapsible "Tally starts here" card.

New in the sidebar branches from the shown tree's root, else the most recently active root; `root: true` starts a
new root and its first branch. A tally replaces its conversation composer through the SDK's `composer` renderer,
using the same start path and remembered Isolated/Shared preference. Hover a stored message and choose
**Branch from here** to fork at that entry; `lineage.branch-at` receives `conversationId` and `entryId` through the SDK.
