A project is a forest of conversation trees. Each root keeps a non-agent tally of one line of work: one intent line per branch, each conversation's latest abstract, notes and landings. Branches do the work with that shared context.

The UI calls a root's tally its **context** ("what every new branch starts from"); "tally" stays the internal name of the
document, tools and model-facing text, where agents and stored entries already use it.

- **Branch** (action `branch`
  `{ from, at?, prompt, images?, isolated?, model?, thinkingLevel? }` → `{ id }`). It forks the source at `at` (default: its latest entry) as an
  ownerless conversation in the project root, optionally isolated in its own worktree. There is no brief or reset:
  it inherits the source context, then the durable `lineage.prompt` task submits the prompt and images as its first
  input. Doc `lineage.branch` holds `{ from, at, intent }`; `inputAt` is when the branch was asked for, not inherited
  activity. The fork happens before the tree root receives a model-visible `lineage.branched` node
  `{ branch, at, intent, images?, from? }`, so the branch does not inherit its own node. The node's model text is one
  line, `#<branch> started by <caller> from #<source>/<at>: <intent>`, where `intent` is the prompt's first 80
  characters on one line (also the branch's title until its summary names it); the prompt and its images stay in the
  branch's own first input, so later branches never inherit them. Nodes written before this carried the whole prompt;
  they are not rewritten and shrink at the next `compact_tally`. `from` is present
  when the source is not the root; that source also gets a display-only marker. The forking commit emits the durable
  event `lineage.branched` `{ id, from, at, intent }` (`Branched` in `api.ts`); lineage's own `named` reactor (for it
  and `lineage.rooted`) has conversations mark the intent title as generated (`generatedTitle`). Lineage provides
  conversations' `conversations.trees` point (`rootOf`, `branchOf`, `abstract`) that summaries use. Plan reads `Branch` (also in `api.ts`) and empties the inherited plan in the commit
  that places the branch's first input.
- **Roots**: doc `lineage.roots` on conversation 1 (`{ roots }`, initially `[1]`) lists the roots. Clients stream it
  (`useRoots()` in `roots.tsx`). Root lookup walks owners and fork sources to a listed root; conversations outside
  those trees have none. Deferred tool `new_root` `{ title }` → `{ id }` creates an empty, ownerless root in the
  project checkout, using conversation 1's model and thinking level. It stores the title and emits `lineage.rooted` (`Rooted` in `api.ts`) in that commit.
  A task receipt commits with creation and a memo records the id, so replay creates only one root.
  Deferred tool `seed_tally` `{ root, text }` seeds an empty listed root from the caller's project reading. It
  atomically writes a genesis `pi.reset` with `head: 'self'`, `data.lineage = { tally: true }`, and
  `<tally from="#caller/latest-entry">` pointing at the reading, then sets `lineage.tally.since`.
  It refuses the caller itself, non-roots, roots with entries and existing tallies. Replay recognises the committed
  genesis with its memoised breadcrumb, so it writes only once. The genesis card links to that source reading.
  An empty root has nothing to branch from: seed it first. Tallies refuse inputs and run no turns.
  `info` returns `{ roots }`, and with `{ id }` also its `root` and `branch` when present.
  `unlist` `{ id }` → `{ roots }` removes a root that never became a tally from the list: it refuses non-roots, the
  last root and tallies. The root and its branches then belong to no tree. Concluding only hides a conversation;
  unlisting is how a mistaken or abandoned root stops being offered to `branch`.
  `recent` `{ id, limit?, types? }` → `RootEvent[]` (`types.ts`) lists a listed root's newest events, newest first
  (default 3, at most 20; only the given `types` when set): landings `{ sha, base?, commits, feature?, title?, from?,
compare? }` (`commits` counts the note's listed commits plus `more`), other notes `{ from?, text }`, new branches
  `{ branch, intent }`, compactions, and the genesis (`started`), each with its `entry` and `at`. With a GitHub
  `origin`, a landing's `compare` is `https://diffshub.com/<owner>/<repo>/compare/<base>...<sha>` (DiffsHub's view of the GitHub range); a note from before
  landings recorded `base` uses the landing before it, which is where the lander's serial queue left the target.
  Catch-up notes and abstracts are left out. The sidebar's root row shows the landings.
  Workspaces' `github` action gives the root page's landing cards the same range.
  `compact` `{ id, instructions? }` → `{ taskId }` starts the same compaction as `compact_tally`, for the root row's menu
  and the palette's Compact command on a root.
- **Tally**: conversation-scoped doc `lineage.tally` (latest history) holds
  `{ abstracts: Record<string, { anchor, at, text, title?, feature? }>, tokens: number, since?: number }`:
  each conversation's open abstract, estimated model-visible context tokens, and the entry where the root became a tally. Forks start with an empty doc,
  not the source's bookkeeping. Tokens are recounted from active context after commits that append root entries,
  including resets and compaction. The root footer shows the estimate as "Context · … tokens".
  `lineage.abstract` entries hold `{ conversation, at, text, title?, feature?, anchor? }`, with `at` pointing to the
  answer summarized. An abstract is liquid until its conversation lands, like an uncommitted working tree: the first
  one is model-visible and becomes the anchor; later ones are carriers without model messages (`anchor` set) whose
  `edits` replace the anchor's text in place, so the tally never reorders. An anchor a compaction or genesis replaced
  takes no edits; the next abstract opens a new one. While a compaction of the tally runs, an update opens a new anchor
  too and omits the old one, since the compaction may replace it after the update. Storage stays append-only. The
  transcript shows each anchor as a card with its newest carrier's text and `#N/at` breadcrumb; carriers render
  nothing, and a frozen anchor hides.
- **Notes**: `note` `{ to: id | 'root', text }` writes a `lineage.note` without waking the target; `'root'` resolves
  the caller's tree root. Its model reads `Note from #N: …` with its next input, or a future branch inherits it from
  the tally. Note cards use the mellow yellow `--note` theme token. `ConversationRef` names conversations by feature,
  else title, then `#N`; model text keeps bare ids. Other extensions call `leaveNote(host, to, text, source?)`;
  `'root'` needs `source.from` and errors if it has no root. Successful landings leave a note in the submitter's root
  (unless it is that root or has none): the reactor `lineage/landing-notes` handles each `workspaces.landed` event
  once, placing the note in a tally inside its own transaction, or, for a root that is no tally yet, creating a
  `lineage.landing-note` task in it that delivers the note as a write (request id `lander-root:<submission>`). The
  note has `source: 'lander'`, `sha`, `base`, `target`, `commits`, `paths`, `divergence` and
  `at`. Text includes the submitter's `#N/at` breadcrumb and `Diverged: …`, including "None"; the landing card shows
  divergence too (up to 10 commits and 8 changed paths). A landing is the commit of a liquid abstract: in a tally, a
  lander note for a submitter with an open abstract carries it as `abstract` `{ at, text, title?, feature? }` and a
  `State at landing (abstract as of #N/at):` block, omits the anchor in the same write and closes it, so the frozen
  state lives only in the landing; the card shows it as a collapsed "State at landing". The next abstract opens a new
  anchor after the landing. Every lander note in a tally is placed in one transaction that checks for an open
  abstract and freezes it if there is one, with request-id deduplication, so no abstract can open between the check
  and the landing.
- **Go back** (`rewind.ts`, `rewind.tsx`): the message action **Go back to here** on any stored message of a non-root
  conversation (standing agents included) opens a confirm dialog fed by `rewindPreview {conversation, at}`: steps set
  aside; the files the set-aside path touched (files of its commits, `git show --name-only`, and paths its `edit` and
  `write` calls named) with their `git diff --numstat` against the checkout's tip at the entry, untracked, or
  "changed" (no HEAD to count against, or no difference), so uncommitted work from before the entry stays out;
  commits since; and the conversations that built on the path (subagents and branches it started, conversations it
  messaged per `board.sent` events, read by kind since board needs lineage). User-only `rewind {conversation, at, summarize?}` runs task
  `lineage.rewind` in the conversation: it appends one `lineage.rewound` entry whose `edits` omit every entry after
  `at` that still contributes (and restore entries up to `at` an earlier go-back changed), and whose user-role message
  is the note. The conversation keeps its id, worktree, files and commits; nothing runs until the next input, and the
  prefix up to `at` contributes byte-identically, so a warm provider cache can hit. With `summarize`, the summary model
  summarizes the set-aside path into the note (memoized; without an answer the note lists the files). The task reads
  the context first and memoizes the facts with that revision (its newest entry); a retry or the final commit refuses
  with "changed meanwhile" once any entry that the model sees lands after it. It refuses roots, busy conversations (a
  run or queued input), running compactions (both at admission and in the final commit), and points before the newest
  head marker (a compaction or reset). A suffix of only tool results can be set aside too. It
  emits `lineage.rewound {conversation, at, entry, dependents}` and writes a display-only
  `lineage.rewound-dependent` marker in each dependent, which keeps running. The transcript folds what a go-back set
  aside (`data.setAside`) into **N steps set aside · show**.
- **Notify**: `notify` `{ id, wake? }` starts `lineage.notify` in the caller. It waits until the target and its
  subagents are idle, then delivers `#id finished · <title>` with its last own answer (≤1500 chars), not an inherited
  source answer. `wake` (default true) submits a follow-up placed as `lineage.finished`; `wake: false` leaves a note
  with `source: 'finished'`. Request id
  `lineage:notify:<target>:<task>` deduplicates delivery; calling again for the same id aborts the pending task.
  The caller's `lineage.notified` `{ answers: { [target]: entryId } }` records the answer entry each delivery carried;
  when the idle target's newest own answer is that one, the task watches commits for the target's next entry and
  waits for its next idle instead of repeating it.
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
- **Compaction**: deferred tool `compact_tally` `{ root, instructions? }` → `{ taskId }` starts the harness's
  existing compaction on a listed tally root, refusing non-roots, non-tallies and roots already compacting.
  Compaction summarizes older tally content and keeps recent entries verbatim; a short tally may stay unchanged.
  Instructions guide that summary without deleting history. To correct a recent or standing decision, @ultimate leaves
  a superseding `note {to: root}`. Its own model keeps the idea,
  principles, standing decisions and each conversation's id, prompt, outcome, divergence, commits and breadcrumbs,
  merging superseded detail. Every top-level conversation's summary source is its model view with edits applied, so
  abstracts read as last updated and frozen ones stay out. Branch compaction focuses on intent and progress; subagents keep Pi's default.

Other extensions use `host.want(LineageApi)` (`api.ts`, with the `Roots` document): `rootOf(id, ctx)` resolves tree membership,
`leaveNote(to, text, source?)` writes without waking, and `branchOf(id, ctx)` returns `{ root, intent? }` for top-level
non-root conversations in a tree (undefined for roots, owned conversations and outsiders).
`abstract(tx, id, { text, at, title?, feature? })` opens or updates `id`'s abstract in that root in the caller's
transaction, before its first table write because it reads conversation records; it is a no-op wherever `branchOf`
is undefined. The conversations summarizer uses this to publish an abstract after each completed exchange.
`branch({ from, prompt, at?, isolated?, model?, thinkingLevel?, deliver?, by?, receipt? }, ctx)` starts a normal lineage branch.
An optional `receipt: { taskId, callId }` records the branch id atomically with the fork in the originating task's
`lineage.branch-receipts` document. Repeating that task and call returns the same branch; Pi retires the receipt when
the task completes. The method returns `{ id }`. With `deliver: false`, no `lineage.prompt` task is created: the caller
must deliver its first input (the board uses a reply-enabled message). `by: conversationId` attributes the tally's branch node to that caller,
including its standing-agent name when available.

The user talks to @ultimate in its own conversation, opened by the top-bar @ultimate button or first sidebar row; it picks a root by reading tallies and starts coordinator branches.
A branch is the conversation; the coordinator is the agent that runs it, so the header and System lanes label it `branch · coordinator`.
There is no manual creation page or message-hover branch action. Coordinator branches keep their composers for steering.

An empty root shows what the `EmptyRoot` point (`ui.tsx`) provides: onboarding's **Start here** card
(`onboarding/survey.tsx`), an optional focus and **Set up with @ultimate**.
This calls user action `onboarding.start` with that root and the focus verbatim as instructions, then opens @ultimate.
Once started, it shows only a quiet **@ultimate is setting up this project · open** link from `onboarding.starts`.
@ultimate reads the project and writes its first tally with `seed_tally` before starting work.

Listed roots with a tally or existing history replace their composer through the SDK's `composer` renderer with a
read-only footer: **Context**, "What every new branch starts from. @ultimate maintains it.", estimated
tokens, and **Talk to @ultimate**. There is no text input. @ultimate maintains standing decisions with `note` and
reshapes tallies with `compact_tally`; on a root the palette's Compact runs lineage `compact` and its composer-focus
command is hidden. A root's transcript shows no summary or assessment lines.

Old stored notes and survey inputs still render quietly, without creation controls. Old brief resets still render;
a genesis reset shows a collapsible **Context starts here** card.
