A live activity feed for every agent, kept in one root-conversation document so a single stream can animate a map of
all conversations and their subagents. It has no UI of its own yet; enable `canvas` in settings.

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
  updatedAt: number
}
type CanvasTool = { id; name; label; status: 'running' | 'done' | 'error'; at }
type CanvasEdit = { path; added; removed; at }
```

Times are Unix milliseconds. A tail longer than its limit starts with `…`. A tool's `at` is when it was called; a
text's `at` is when it last changed. Labels are short summaries, as the transcript titles calls: `read server/api.ts:436-525`,
`$ pnpm test`, `edit web.tsx`, `start scout: <task>`, `wait #12`, `codemode: <first line>`; other tools show
`name key=value …`. Paths are relative to the conversation's cwd, else start with `~`. An edit's line counts come
from the edit tool's patch; a write counts all its lines as added.

`waitingOn` lists the children of running `subagent` calls that block: a foreground `start` or `message`, or a
`wait`. It clears when the call ends. Calls made from inside codemode are not seen.

Titles, labels, parent links, busy and run state, and assessments are not repeated here: they come from the core
conversation list and `ultimate.conversation-overview`.

## How it stays current

On open it ranks conversations by their newest entry and rebuilds the 150 most recent from their last 48 entries and
`pi.live`. Afterwards it follows commit publications: answers and tool results as they commit, and each
conversation's `pi.live` for the streaming answer and the tool round's statuses. A call that leaves the round without
a result becomes `error`. Changes are coalesced into at most one commit every 250 ms, writing only the changed fields
of the changed rows.

Rows exist only for agents with activity. Archived conversations (`ext.conversations.archived`) and their subagents
are dropped, and rebuilt when unarchived. At most 150 rows are kept; the least recently active go first.
