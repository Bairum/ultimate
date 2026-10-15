A project is a forest of conversation trees. Each root holds the idea of one line of work and keeps its tally; branches fork from any conversation at any entry, each starting from a brief aimed at its intent.

- **Branch** (⌘K "Branch…", "Branch from here" on a message, or action `branch`
  `{ from, at?, prompt, images?, isolated?, model?, thinkingLevel? }` → `{ id }`). Every branch starts in the same
  composer as New (model, Isolated, pasted images); images go with the prompt into the branch's first input. It
  forks the source at `at` (default: its latest entry) as an ownerless conversation in the project root, optionally
  isolated in its own worktree. The background task `lineage.brief` asks the branch's model to write a brief of the
  source context aimed at the prompt, places it as a `pi.reset` with `data.lineage = { from, at }`, then submits the
  prompt. The branch's model sees only the system prompt, the brief and what follows; history above stays readable.
  The source gets a display-only `lineage.branched` entry. The branch's `inputAt` is the moment it was asked for, so
  it sorts as new while its history is the source's. Doc `lineage.branch` on the branch holds
  `{ from, at, intent, status: 'briefing' | 'ready' | 'failed', error? }`; action `retry` `{ id }` restarts a failed
  brief.
- **Roots**: doc `lineage.roots` on conversation 1 (`{ roots }`, initially `[1]`: a fresh project starts with its
  first conversation as a root). Clients stream it (`useRoots()` in `roots.tsx`), so every page sees a new root at
  once. A conversation's root is found by walking up owners (subagents) and fork sources (branches) to the top; the
  top is its root when it is in `roots`, otherwise it has none (landers, conversations from before lineage). Action
  `newRoot` `{ prompt, images?, isolated?, model?, thinkingLevel? }` → `{ id }` starts an ownerless conversation, adds
  it to `roots`, titles it by the prompt (event `lineage:rooted`, like `lineage:branched`) and creates a
  `lineage.prompt` task in the same transaction that submits the prompt as its first input (request id
  `lineage:root`): no brief, and a crash before delivery cannot leave the root empty. Without a `model` it gets the
  project default, conversation 1's. An isolated root's first request waits for its checkout in the workspaces prompt
  section. Action `root` `{ id }` (⌘K "Make this a root") adds a top-level conversation that is not a branch; `info`
  returns `{ roots }`, and with `{ id }` also that conversation's `root` and `branch`.
- **Notes**: the `note` tool `{ to: id | 'root', text }` (`'root'`: the caller's tree root) writes a `lineage.note` entry in the target without waking it;
  its model reads `Note from #N: …` with its next input. Other extensions call `leaveNote(host, to, text, source?)`;
  `'root'` there needs `source.from` and errors when it has no root. Landings from workspaces go to the submitter's
  tree root (none when the submitter is that root or has none) with `source: 'lander'` and structured `sha`, `target`,
  `commits`, and `paths`: a compact success card links to the submitter and keeps the root's tally (up to 10 commits and 8 changed paths).
- **Notify**: the `notify` tool `{ id, wake? }` starts a background task `lineage.notify` in the caller that waits
  until #id is idle (`waitForIdle`: its runs and its subagents), then delivers `#id finished · <title>` with its last
  answer (≤1500 chars). `wake` (default) submits it as a follow-up input placed as a `lineage.finished` entry, so it
  starts the caller's next run; `wake: false` leaves a `lineage.note` with `source: 'finished'`. Both use request id
  `lineage:notify:<target>:<task>`, so a resumed task delivers once; calling `notify` again for the same id aborts the
  pending one.
- **Catch-up on resume**: `lineage.seen` (`{ main, at }`) records the target tip each top-level conversation saw,
  seeded at creation (in the branch transaction for branches) and on the first open for existing conversations.
  On an idle resume, a `GenerationTask.beforeInput` hook checks main (an isolate's workspace target), lists up to
  30 newly landed commits, and puts overlaps first: workspace changes against the merge-base, or the conversation's
  own edit/write calls in a shared checkout. Rows include the `Ultimate-Conversation` trailer and title when present;
  an isolate also gets its behind count. No new commits means no note; tool rounds and mid-run notes do not trigger it.
  The local Pi Durable patch runs the hook in the first input’s placement transaction. It appends a
  `lineage.note` with `source: 'main'` before that input in both the transcript and model context.
  The note, seen tip, and input commit atomically, so retries and restarts cannot duplicate the catch-up.
- **Prompt**: the `lineage` section tells each top-level conversation where it sits in its tree (a root, or `Root: #R`)
  and how to read the others; it never lists the other roots, so it stays cache-stable (codemode `ultimate.entries(id)`, `ultimate.search()`).
- **Compaction**: top-level conversations summarize with their own model and a lineage focus (root: idea, principles,
  standing decisions, tally of landings and branches, for every conversation in `roots`; branch: intent and progress). Subagents keep Pi's default.

While the brief is written, the `conversation.overlay` slot covers the branch, the source's history and its composer,
which stay inert beneath it: a glass ball (`crystal.tsx`, adapted from React Bits' CrystalizedBall on `ogl`) that the
history streams down into as dust. It shows only on that branch, at once when the branch was started in this tab, and
not when the brief finished while another conversation was shown. Once the brief is ready, after at least 1.5 s, the
ball condenses into an orb that drops into the composer; a glow spreads along it, the dimming lifts and the composer
takes focus. A failed brief fades at once and the composer's status line says why, with Retry. `?briefing` holds the
overlay up on the conversation shown first, and a click plays the finish, to polish it on a preview instance.

New in the sidebar branches from the root of the shown tree, else the most recently active root; a draft with
`root: true` starts a new root instead. Hover a stored message and choose **Branch from here** to
branch at that entry. The contextual `lineage.branch-at` command receives `conversationId` and `entryId` through the SDK.
