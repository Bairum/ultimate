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
  those trees have none. Action `newRoot` `{ prompt, model?, thinkingLevel? }` → `{ id }` creates a root, titled by
  the prompt (what its tree is for), and starts its survey toward it; `id` is the root. The root uses the chosen model
  or conversation 1's default, and emits `lineage:rooted`.
  **Survey**: an empty root (a fresh project's conversation 1, a new root, an empty conversation made a root) has
  nothing to branch from, and `branch` refuses it. Action `survey` `{ root, focus? }` → `{ id }` sets
  `lineage.tally.surveying` and starts the background `lineage.survey` task: it submits the reading prompt (what the
  project is, how to run, check and test it, its architecture, conventions and current state; read-only; following the
  focus, the user's instructions, first) as a `lineage.survey` input, waits until the root is idle (the user can steer the reading), then
  converts the root as `root` does, distilling with a reading focus. Branching is refused while it reads or converts.
  Typing in a tally's composer opens a side chat with it (↵) or starts a branch from its tip (⌥↵); the server refuses
  inputs to tallies.
  Action `root` `{ id }` (⌘K "Make this a root") adopts a top-level non-branch conversation or converts an existing
  root. With history, it is refused while the conversation has a live run, compaction, notify or subagent report, or a
  workspace submission queued or landing; otherwise `lineage.tally.converting` refuses inputs at once and a durable
  `lineage.convert` task asks its own model for a genesis distillation. It writes a `pi.reset` with `head: 'self'`,
  `data.lineage = { tally: true }` and model text `<tally from="#R/at">…</tally>` only while `at` is still the tip;
  writes that arrived meanwhile (notes, landings) are distilled again with it. A failure clears `converting` and
  leaves a notice. An empty conversation is only added to the roots and waits for its survey; converting a tally again
  does nothing. Roots with history from before
  tallies keep their ordinary composer and can run until converted. `info` returns `{ roots }`, and with `{ id }`
  also its `root` and `branch` when present.
- **Tally**: conversation-scoped doc `lineage.tally` (latest history) holds
  `{ abstracts: Record<string, { anchor, at, text, title?, feature? }>, tokens: number, since?: number,
converting?: true, surveying?: true }`: each conversation's open abstract, estimated model-visible context tokens, the
  entry where the root became a tally, whether its genesis is being distilled, and whether it is reading the project. Forks start with an empty doc,
  not the source's bookkeeping. Tokens are recounted from active context after commits that append root entries,
  including resets and compaction. The root composer status shows the estimate as "Tally · … tokens".
  `lineage.abstract` entries hold `{ conversation, at, text, title?, feature?, anchor? }`, with `at` pointing to the
  answer summarized. An abstract is liquid until its conversation lands, like an uncommitted working tree: the first
  one is model-visible and becomes the anchor; later ones are carriers without model messages (`anchor` set) whose
  `edits` replace the anchor's text in place, so the tally never reorders. An anchor a compaction or genesis replaced
  takes no edits; the next abstract opens a new one. While a compaction of the tally runs, an update opens a new anchor
  too and omits the old one, since the compaction may replace it after the update. Storage stays append-only. The
  transcript shows each anchor as a card with its newest carrier's text and `#N/at` breadcrumb; carriers render
  nothing, and a frozen anchor hides.
- **Side chats**: a conversation with a tally at this point in time, before anything becomes a branch. Action `side`
  `{ root, prompt, images?, model?, thinkingLevel? }` → `{ id }` forks the tally's tip as an ownerless conversation in
  the shared checkout (never isolated) with label `side chat`; the `lineage.prompt` task delivers its prompt. A root
  has one open at a time: `lineage.roots` keeps them as `sides` (root → side chat), so every client sees them with the
  roots. Doc `lineage.side` on the side chat holds `{ root, at, ending?, ended?, branch? }`. It writes nothing into
  the tally while open: no prompt node, no `lineage.branch`, no abstracts (`branchOf` is undefined for it); catch-up
  applies as in any tree conversation. It has every tool a coordinator has, plus the deferred `propose_branch`.
  `propose_branch` may only be called by an open side chat. A branch forked from a side chat's message
  ("Branch from here") does not keep it: every branch starts with the tool configuration cleared.
  `propose_branch` `{ prompt }` renders as a "Proposed branch" card whose "Start branch…" opens the start page with
  that prompt. It ends only when the user ends it, with action
  `endSide` `{ root, side, mode, prompt?, images?, isolated?, model?, thinkingLevel? }`, refused unless `side` is
  still the root's open side chat, so a stale page cannot end a newer one:
  `discard` closes it and the tally gets nothing; `note` has the summary model (else the side chat's own) write what
  it settled, at most 800 characters, appended to the root as a model-visible `lineage.note`
  `{ text, from, source: 'side' }` reading `Side chat #S: …`; `branch` writes the note, then starts a branch from the
  tally's tip right after it, so the branch inherits the note; its prompt node carries `side` and reads
  `#B was started from the tally (#R/at), ending side chat #S, with the prompt:`. Note and branch run in the
  durable `lineage.side` task: the model's answer is memoised, the note commits with the close (or the step to the
  branch), and the branch with the task's end, so a rerun writes each once. `sideDraft` `{ root, side }` →
  `{ prompt }` returns the side chat's last proposal, else one the summary model drafts. An ended side chat takes no
  input and stays readable. Ending is refused while it still answers.
- **Notes**: `note` `{ to: id | 'root', text }` writes a `lineage.note` without waking the target; `'root'` resolves
  the caller's tree root. Its model reads `Note from #N: …` with its next input, or a future branch inherits it from
  the tally. Note cards use the mellow yellow `--note` theme token. `ConversationRef` names conversations by feature,
  else title, then `#N`; model text keeps bare ids. Other extensions call `leaveNote(host, to, text, source?)`;
  `'root'` needs `source.from` and errors if it has no root. Successful landings leave a note in the submitter's root
  (unless it is that root or has none), with `source: 'lander'`, `sha`, `target`, `commits`, `paths`, `divergence` and
  `at`. Text includes the submitter's `#N/at` breadcrumb and `Diverged: …`, including "None"; the landing card shows
  divergence too (up to 10 commits and 8 changed paths). A landing is the commit of a liquid abstract: in a tally, a
  lander note for a submitter with an open abstract carries it as `abstract` `{ at, text, title?, feature? }` and a
  `State at landing (abstract as of #N/at):` block, omits the anchor in the same write and closes it, so the frozen
  state lives only in the landing; the card shows it as a collapsed "State at landing". The next abstract opens a new
  anchor after the landing. Every lander note in a tally is placed in one transaction that checks for an open
  abstract and freezes it if there is one, with request-id deduplication, so no abstract can open between the check
  and the landing.
- **Notify**: `notify` `{ id, wake? }` starts `lineage.notify` in the caller. It waits until the target and its
  subagents are idle, then delivers `#id finished · <title>` with its last own answer (≤1500 chars), not an inherited
  source answer. `wake` (default true) submits a follow-up placed as `lineage.finished`; `wake: false` leaves a note
  with `source: 'finished'`. Request id
  `lineage:notify:<target>:<task>` deduplicates delivery; calling again for the same id aborts the pending task.
- **Catch-up on resume**: `lineage.seen` `{ main?, at?, tally? }` tracks the target commit and last accounted-for root
  entry. Branch creation seeds `tally` to the position its fork inherits: the newest root entry in its history up to
  the fork point, or the `data.tally` of the newest catch-up note there, which every catch-up records. Without either
  it starts from `lineage.tally.since`. Prompts of the conversations it was forked from are left out: it reads them as
  their inputs. On an idle resume, the transactional `GenerationTask.beforeInput` hook builds
  "Meanwhile in #R's tree": open abstracts whose anchor or a carrier is new, as they read now (preferred over
  prompts), prompts without an abstract, landings with divergence and breadcrumbs (a conversation without an open
  abstract shows its newest landing's frozen state), notes, and any new tally distillation. It excludes the caller's own
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
  merging superseded detail. Every top-level conversation's summary source is its model view with edits applied, so
  abstracts read as last updated and frozen ones stay out. Branch compaction focuses on intent and progress; subagents keep Pi's default.

Other extensions use `host.use<LineageService>('lineage')` (`server.ts`): `rootOf(id, ctx)` resolves tree membership,
`leaveNote(to, text, source?)` writes without waking, and `branchOf(id, ctx)` returns `{ root, intent? }` for top-level
non-root conversations in a tree (undefined for roots, owned conversations, side chats and outsiders).
`abstract(tx, id, { text, at, title?, feature? })` opens or updates `id`'s abstract in that root in the caller's
transaction, before its first table write because it reads conversation records; it is a no-op wherever `branchOf`
is undefined. The conversations summarizer uses this to publish an abstract after each completed exchange.

New, "Branch…" and "Branch from here" open the start page (`start.tsx`) in `conversation.overlay`, with the
conversation beneath inert. It shows New's Branch / New root tabs, source and quoted branch point above the
new-conversation composer. Its URL (`?new`, `?new=<from>`, `?new=<from>.<at>`, or `?new=<root>&side=<side>` for the
branch a side chat ends in, prefilled with its draft) survives reload; Back or Esc closes it,
switching conversations closes it, and each start point keeps its draft. Sending replaces the composer with the sent
prompt and its steps (forking the source, or creating the root, then starting the run); the page holds over the new
conversation until its first message shows, then fades into it. A tally's ⌥↵ branch shows the same page. A failed start
returns to the composer with the draft and the error. There is no briefing overlay or retry action. Old stored brief resets still render;
a genesis reset instead shows a collapsible "Tally starts here" card.

New in the sidebar branches from the shown tree's root, else the most recently active root; `root: true` starts a
new root, which reads the project in the shared checkout (no Isolated switch). While that root has not read the project,
New's Branch tab explains why and offers to open it instead of a composer. An empty root's composer is the "Start here"
card (`survey.tsx`): an optional focus and "Make yourself familiar with the project". While it reads, the root keeps
its composer for steering, with "Getting familiar with the project" in its status line; while its genesis is
distilled, a quiet "Writing the tally…" line replaces it. The survey input renders as a collapsible "Getting familiar
with the project" card. A tally replaces its conversation composer through the SDK's `composer` renderer:
↵ opens a side chat (`start` prop of `NewConversationComposer`), ⌥↵ (`alternate` in the draft) starts a branch with
the same start path and remembered Isolated/Shared preference. Its status line shows "Tally · … tokens" and both
keys. A root with an open side chat shows the side chat instead (a replacing redirect, so Back leaves): its view is
the tally as it was when the chat opened, then the chat, with a "Side chat · #S [Branch…] [Keep as note] [Discard]" bar
above its composer; an ended one shows how it ended instead of a composer. The sidebar lists no side chats; a root
with an open one is marked "side chat" and stands for it. A side note renders as a quiet "Side chat · #S" card with
"→ #B" when it started a branch. Hover a stored message and choose
**Branch from here** to fork at that entry; `lineage.branch-at` receives `conversationId` and `entryId` through the SDK.
