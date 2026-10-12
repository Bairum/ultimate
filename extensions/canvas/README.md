The Canvas surface: every conversation and subagent as a live panel on a zoomable map around a hub where conversations
start. It replaces the Agent surface's sidebar and conversation column (switch to Agent for those); enable `canvas` in
settings.

## The map

The hub sits at the centre. Type into it and press Enter to start a conversation, isolated in its own checkout when the
Isolated toggle is on (the sidebar's remembered creation type, `ext.conversations.creationType`, so both views agree;
shown only while `workspaces` is enabled). A shared start reuses the shown empty draft, as the sidebar's New does. The
new panel springs out of the hub, and the view frames both.

Each top-level conversation is a ray from a slot on the first ring; the subagents it owns pack outward along that ray,
in creation order. Slots fill top, bottom, right, left, then in between, and a conversation keeps its slot while the
page is open, so a new conversation or subagent never moves another branch. Moves glide; history forks, archived
conversations and empty drafts stay off the map.

A panel's outline is its state: Working (purple, pulsing), Waiting on subagent (blue), Queued (dashed), Needs decision
(warm), Done (green, Luna's opinion), Replied (green), Run failed (red), Idle. A tree **needs a decision** while Luna
says one of its conversations needs input, or a workspace in it is ready and was never landed (`decisions()` in
[model.tsx](model.tsx); the workspaces document has no tip, so a checkout landed once counts as landed). Its panels
name the reasons ("needs input", "workspace not landed", "worktree #12 not landed").

Finished work shrinks: a finished subagent with nothing to decide becomes a pill, and a tree with nothing working and
nothing to decide folds into a **conclusion card** (title, state, Luna summary, how many subagents it folded, and the
spend of the whole tree). `ConclusionCard` takes `conclusion?: ReactNode`, rendered under the summary: the place for a
richer outcome (commits, what landed, a screenshot). Hovering a card or pill opens it to a full panel; the shown
conversation always keeps its full panel and its tree.

Zoomed out (below 60 %), panels are far cards: big title, state colour, one line. Closer, a panel shows its latest
calls as chips (running ones shimmer), the streaming thinking (dim) or answer, its latest edits, and when idle Luna's
summary with the end of its last answer. Every panel has a context bar; a panel's line reads
`42% of 272k · ↑26k ↓1.7k · $0.50 · model`, with the spend of the whole tree on a top-level panel, and the hub adds up
everything on the map. Edges from a parent that waits on a subagent carry dots toward it, and one dot runs back when
the wait ends.

Click selects a panel, which shows its conversation; the selection follows the shown conversation and its URL. Enter
or a double-click zooms the panel to fill the view with the real transcript and composer. Escape goes back to the map,
except while the agent works: then Escape stops the run, as in the agent view, and the Map button or zooming out goes
back. The viewport is kept in this browser (`localStorage`).

Keys, all in ⌘K under Canvas and only on this surface, never while typing: `=` or `+`, and `-` (or mod+wheel) zoom, `0` fits
everything, `f` fits the selected tree, arrows select the nearest panel that way, Enter opens, Escape goes back, `h`
flies to the hub, `n` starts a conversation there. The commands also rename, archive or unarchive the selected
conversation, show or hide archived conversations (the toolbar's archive toggle), and open its workspace details.

A panel's `…` menu offers what the sidebar row and the agent view did: open, stop the run, workspace details, and for a
top-level conversation rename, clear context (the `conversations.reset` command and its dialog), archive or unarchive
(the sidebar's `ext.conversations.archived`, so both views agree). An isolated conversation shows its `W<id>` badge,
which opens the Workspaces panel.

Everything arrives over one stream on the root conversation, whatever the number of panels:
`ultimate.canvas`, `ultimate.conversation-overview` (with `conversations`) and `ultimate.workspaces` (with
`workspaces`). Only visible panels render, and far panels are a few elements each.

## The document

`ultimate.canvas` lives on the root conversation; subscribe with
`/api/events?conversation=1&docs=ultimate.canvas`. Its shape is in [types.ts](types.ts):

```ts
type CanvasState = { agents: Record<string, CanvasAgent> } // keyed by conversation id
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
conversation list and `ultimate.conversation-overview`.

## How it stays current

On open it ranks conversations by their newest entry and rebuilds the 150 most recent from their last 48 entries,
`pi.live`, `pi.usage` and `pi.agent`. Afterwards it follows commit publications: answers and tool results as they commit, each
conversation's `pi.live` for the streaming answer and the tool round's statuses, and its `pi.usage` and `pi.agent`. A call that leaves the round without
a result becomes `error`. Changes are coalesced into at most one commit every 250 ms, writing only the changed fields
of the changed rows.

Rows exist only for agents with activity. Archived conversations (`ext.conversations.archived`) and their subagents
are dropped, and rebuilt when unarchived. At most 150 rows are kept; the least recently active go first.
