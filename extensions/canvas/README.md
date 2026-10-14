The Canvas surface: every conversation and subagent as a live panel on a zoomable map around a hub where conversations
start. It replaces the Agent surface's sidebar and conversation column (switch to Agent for those); enable `canvas` in
settings.

## The map

The hub sits at the centre. Type into it and press Enter to start a conversation, isolated in its own checkout when the
Isolated switch is on (filled in the accent; quiet when off). It keeps the sidebar's remembered creation type,
`ext.conversations.creationType`, so both views agree, and shows only while `workspaces` is enabled. A shared start reuses the shown empty draft, as the sidebar's New does. The
new panel springs out of the hub, and the view frames both.

Each top-level conversation is a ray from a slot on the first ring; the subagents it owns pack outward along that ray,
in creation order. Slots fill top, bottom, right, left, then in between, and a conversation keeps its slot while the
page is open, so a new conversation or subagent never moves another branch. Moves glide; ownerless history forks get their own ray, while concluded
conversations and empty drafts stay off the map.

A panel's outline is its state: Working (purple, pulsing), Waiting on subagent (blue), Queued (dashed), Needs decision
(warm), Done (green, the summary model's opinion), Replied (green; the overview row's `answered` run state), Run failed (red), Idle. A tree **needs a decision** when the
server says so (see [Conclusions](#conclusions)): once the whole tree is idle, the summary model says one of its conversations needs
input, or a checkout in it holds commits that were never landed. Its panels name the reasons ("needs input",
"#12: 3 commits not landed"; a subagent's question shows as "#49 needs input" on its top-level panel). While anything in
the tree works, nothing shows: unlanded work is expected then.

Finished work shrinks: a finished subagent with nothing to decide becomes a pill (its role gives way before its id), and
a tree with nothing working and nothing to decide folds into a **conclusion card**. Once concluded, the card shows the
headline, the summary model's summary of the whole tree, the tree's last screenshot, and chips for what it produced ("landed: …",
"3 commits", "pushed", "2 subagents", "12 files"); before its first conclusion, or without a summary model, its title, state and
summary. New work dims the card and marks it "outdated" until the next conclusion replaces it. Hovering a card or pill
opens it to a full panel; the shown conversation always keeps its full panel and its tree.

Zoomed out (below 60 %), panels are far cards: big title (a card's headline), state colour, one line. Closer, a panel
shows its latest calls as chips (running ones shimmer; when they do not fit, the oldest fade out at the left), the
streaming thinking (dim) or answer, its latest edits, and when idle the summary model's summary, or, when it has none or a decision
waits, its last answer under a label, starting with `…` when cut. Every panel has a context bar; a panel's line reads
`42% of 272k · ↑26k ↓1.7k · $0.50 · model`, with the spend of the whole tree on a top-level panel, and the hub adds up
everything on the map. Edges from a parent that waits on a subagent carry dots toward it, and one dot runs back when
the wait ends.

When the shown tree spawns a subagent, the view re-frames the tree gently so the newcomer is in sight, never zooming
in, unless you moved the map in the last four seconds.

Click selects a panel, which shows its conversation; the selection follows the shown conversation and its URL. Enter
or a double-click zooms the panel to fill the view with the real transcript and composer. Escape always goes back to
the map without stopping the run, even from the composer while the agent works. Use the explicit Stop button to stop
a run; Escape still stops runs on the Agent surface. The Map button or zooming out also goes back. The viewport is
kept in this browser (`localStorage`).

Keys, all in ⌘K under Canvas and only on this surface, not while typing except Escape from the composer: `=` or `+`,
and `-` (or mod+wheel) zoom, `0` fits everything, `f` fits the selected tree, arrows select the nearest panel that way,
Enter opens, Escape goes back, `h` flies to the hub, `n` starts a conversation there. The commands also rename, conclude or resume the selected
conversation, show or hide concluded conversations (the toolbar's concluded toggle), and open its workspace details.

A panel's `…` menu offers what the sidebar row and the agent view did: open, stop the run, workspace details, and for a
top-level conversation rename, clear context (the `conversations.reset` command and its dialog), conclude or resume
(the sidebar's `ext.conversations.archived`, so both views agree). An isolated conversation’s `#<id>` reference opens the Workspaces panel.

Everything arrives over one stream on the root conversation, whatever the number of panels:
`ultimate.canvas`, `ultimate.conversation-overview` (with `conversations`) and `ultimate.workspaces` (with
`workspaces`). Only visible panels render, and far panels are a few elements each.

## The document

`ultimate.canvas` lives on the root conversation; subscribe with
`/api/events?conversation=1&docs=ultimate.canvas`. Its shape is in [types.ts](types.ts):

```ts
type CanvasState = {
  agents: Record<string, CanvasAgent> // keyed by conversation id
  trees: Record<string, CanvasTree> // keyed by top-level conversation id
}
type CanvasAgent = {
  tools: CanvasTool[] // the last 8 calls, newest last
  thinking?: { text: string; at: number } // tail (240 characters) of the latest or streaming thinking
  writing?: { text: string; at: number } // tail (400 characters) of the latest or streaming answer text
  edits: CanvasEdit[] // the last 4 edits and writes, newest last
  waitingOn?: number[] // children this agent waits on
  usage?: CanvasUsage
  updatedAt: number
}
type CanvasUsage = {
  provider?: string // the model of its `pi.agent`
  model?: string
  context?: number // tokens in context, absent while unknown
  input: number // totals of its own `pi.usage`
  output: number
  cacheRead: number
  cost: number
}
type CanvasTool = { id; name; label; status: 'running' | 'done' | 'error'; at }
type CanvasEdit = { path; added; removed; at }
type CanvasTree = {
  decision?: { reasons: CanvasReason[] } // what the idle tree waits for
  conclusion?: CanvasConclusion // its latest conclusion, small
}
type CanvasReason = { kind: 'needs_input' | 'unlanded'; conversationId; detail } // `needs input`, `#12: 3 commits not landed`
type CanvasConclusion = {
  headline: string
  commits: number
  pushed: boolean
  landed: string[] // names of what landed, in the summary model's words
  subagents: number
  files: number
  screenshot: boolean
  through: number // the newest entry it covers
  at: number
  stale?: true // the tree worked since
}
```

Times are Unix milliseconds. A tail longer than its limit starts with `…`. A tool's `at` is when it was called; a
text's `at` is when it last changed. Labels are short summaries, as the transcript titles calls: `read server/api.ts:436-525`,
`$ pnpm test`, `edit web.tsx`, `start scout: <task>`, `wait #12`, `codemode: <first line>`; other tools show
`name key=value …`. Paths are relative to the conversation's cwd, else start with `~`. An edit's line counts come
from the edit tool's patch; a write counts all its lines as added.

`usage` counts as the status line does (the shared helpers in `extensions/status-line/context.ts`): the context is the
latest answer's prompt (input, cache read and cache write), unknown after a compaction or reset until the next answer;
the totals add up every model and tool bucket of the conversation's own `pi.usage`. The context window comes from the
model list in the browser.

`waitingOn` lists the children of running `subagent` calls that block: a foreground `start` or `message`, or a
`wait`. It clears when the call ends. Calls made from inside codemode are not seen.

Titles, labels, parent links, busy and run state, and assessments are not repeated here: they come from the core
conversation list and `ultimate.conversation-overview`. Version 2 added `trees`; a version 1 document gains an empty
one.

## How it stays current

On open it ranks conversations by their newest entry and rebuilds the 150 most recent from their last 48 entries,
`pi.live`, `pi.usage` and `pi.agent`. Afterwards it follows commit publications: answers and tool results as they commit, each
conversation's `pi.live` for the streaming answer and the tool round's statuses, and its `pi.usage` and `pi.agent`. A call that leaves the round without
a result becomes `error`. Changes are coalesced into at most one commit every 250 ms, writing only the changed fields
of the changed rows.

Rows exist only for agents with activity. Archived conversations (`ext.conversations.archived`) and their subagents
are dropped, and rebuilt when unarchived. At most 150 rows are kept; the least recently active go first.

## Conclusions

A tree is a top-level conversation and every conversation it owns (subagents, at any depth; ownerless history forks start their own
tree). The server follows commits and, about 300 ms after something touches a tree (an answer, a tool result, a run
starting or ending, queued input, an assessment or overview row, a landed or removed checkout), evaluates it.
When the facet opens or reloads, it evaluates every non-archived tree, so decisions show for trees that settled before
it ran, without new work, and drops the `trees` entries of trees that are not on the map. Archiving a tree drops its
entry and calls off a pending conclusion; unarchiving evaluates it again, which brings back its decision and its stored
conclusion. So `trees` holds only non-archived trees with a decision or a conclusion.

- **Active**: a run, queued input, or an assessment still coming. Its decision clears, a pending conclusion is
  called off, and its conclusion turns `stale` until the tree settles again without newer work.
- **Settled with a decision**: the reasons go into `trees[id].decision`, and no conclusion is made. `needs_input` is
  the current assessment of a conversation's latest answer; a subagent's counts only while its owner has not
  answered since (its question was for the coordinator). `unlanded` comes from Git at evaluation time: a ready
  checkout whose branch tip is not the tip it last landed, and whose target lacks commits of it
  (`rev-list --count target..branch`), run only for members with a ready checkout.
- **Settled with nothing to decide**, work newer than its last conclusion, and a reason to conclude now (it worked
  while this process ran, waited for a decision, or worked past its conclusion): when the summary model (the
  conversations extension's `summaryModel` setting, GPT-6 Luna by default) is available, a durable background task (`canvas.conclusion`) on the top-level
  conversation sleeps through 30 seconds of quiet, then concludes. Activity or a decision meanwhile clears the task's
  `pending` mark and it ends without a word. Without an available summary model nothing is started and nothing is
  shown. The task stores the model it chose before asking, so a restart asks the same one.

Conclusions are never backfilled: a tree that settled before the facet ran gets its decision, not a conclusion, until
it works again. The task collects, from the stored entries of every conversation in the tree, read a page at a time
and newest first without holding them (a tool result's text waits only until its call is read):

- commits from `git commit` output in bash results (`[branch sha] subject`), and the commits of `workspace` and
  `subagent` land results, marked landed;
- pushed, when a bash `git push` succeeded;
- files: the paths of successful edits and writes, and landed paths;
- subagents with their roles; the duration from the first message to the last; the tree's newest screenshot
  (`screenshot` or `browser` image), kept as a reference until the thumbnail is made.

The summary model reads each conversation's visible text (the top-level one's last 8000 characters, a share of 6000 for the
subagents), as source text, never instructions, plus the artifact list, and returns `headline`, `summary` (2–4
sentences: what was asked, what was done, the outcome) and `landed` (names, possibly none). Its response is memoized,
so a restart mid-request resumes without asking again, and its usage counts toward the top-level conversation's
`pi.usage`, as summaries do. Provider or format errors keep the previous conclusion.

The full conclusion, with a thumbnail of the screenshot (at most 480 pixels wide, Pi's `resizeImage` as the browser
tools use), is the conversation document `ultimate.canvas-conclusion` on the top-level conversation; `trees[id]`
carries only what the map needs. A card fetches the full one through the `conclusion` action
(`POST /api/extensions/canvas/actions/conclusion` with `{ args: { id } }`) while it is on screen.
`ULTIMATE_CANVAS_QUIET_MS` shortens the quiet, for tests only.
