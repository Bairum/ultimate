The Agent surface's sidebar and the title bar's @ultimate button: talk to @ultimate, see each root's tree with what
is in flight and what landed, and switch, rename, compact, conclude and resume conversations. It is the UI that brings
the core together, so it sits at the top of the core tier: it reads conversations, workspaces, subagents, lineage and
board, and shows what optional extensions provide through points (`conversations/ui.tsx`: a working phase, a plan task).
Its UI state keeps the keys it had as part of conversations (`ext.conversations.*`).

Every standing agent's row leads with its mark (conversations' `AgentMark`): a small tinted tile with a glyph — a brand
`U` for @ultimate (the title bar's wordmark), a green merge for the lander, arrows for @sync,
a bot for any other resident — with a presence dot in its corner (pulsing while it works or lands, amber while it
waits on you). Then a fixed display name (`Ultimate`, `Lander`, `Sync`, else the name capitalised) with
`@name` small and muted. The same mark sits in the title bar's button and before standing senders in chat bubbles.

@ultimate has its own section at the very top: its row shows `working`, `idle` or an amber
`N waiting on you` (reply-enabled board messages to you still waiting on your answer, plus one for its current final
answer when that asks you questions), and the age of its latest
message. Clicking it opens @ultimate on the Agent surface through `subagents.standing {name: 'ultimate'}`, also before
its conversation exists. Below it, an Agents group lists the lander first, then the other ownerless top-level standing
agents (label `agent`) by ID. These rows are never concluded or hidden and show no summary, feature or assessment:
@lander shows its state (`landing`, `fixing`, `diagnosing`, `working` or `idle`), `queue N` while submissions wait,
its latest landing's short sha (green) and feature tag (truncated, title on hover), and its age; other agents show `working` or `idle` and the age. Their menu only
compacts the context; they are never renamed, cleared or concluded.

The title bar's `@ultimate` button (`titlebar.left`, beside the surfaces, also on phones) opens @ultimate the same way
from every surface. Its mark's dot pulses while @ultimate works and is amber while questions wait on you, with their count.

The sidebar lists the roots below the agents (lineage's `useRoots()`); trees sort by their newest input anywhere in
them. A root's row (`RootRow`, `root.tsx`) is a small dashboard of its tree, not one of its conversations: a scroll
mark (with a pulsing dot while it compacts), the fixed name `Project context` with `#id` small (its summary title only
on hover, since it described the root's history before it held a context) and the size of its context. Below it:

- **In flight · N**: the tree's open branches, newest input first. A branch is open until it is concluded or it landed
  after its latest input (a landed branch that gets new work is open again). Each shows its title, its feature tag,
  a state (`submitted` or `landing` while the lander has it, the working phase while it works, amber `awaiting reply`
  while a reply-enabled message it sent is open, else `idle`) and its age; clicking opens it.
- **Landed**: the last three landings from lineage's `recent {id, types: ['landed']}`, as the shipped feature's tag
  (its title when it has none, the full title on hover) and a commit count linking the GitHub compare range
  (`CommitCount` from workspaces; no link without a GitHub `origin`), with the age. Clicking the feature opens the root
  at that landing note. `N more` unfolds up to ten; the fold state is kept in `ext.conversations.landingsOpen`.

Notes, new branches and compactions stay on the root's page. The row shows no feature, summary or assessment, and the
summary below the tree is not shown for it. Its menu offers Compact context (lineage `compact {id}`, only for a root
that has a context) and Talk to @ultimate; a root is never renamed, cleared or concluded here. Landings refetch
whenever the root's token count changes, which every new entry does. The full branch tree folds under
`All branches · N`, closed by default (`ext.conversations.expandedRoots`), since In flight already lists open work.
Branches nest under their source (`branchOf.conversationId`), with a hairline guide and one indent per depth;
siblings sort by latest input. Older conversations that are neither roots nor branches live in the collapsed
"Earlier · N" group, above "Concluded · N". Isolated rows carry a short `#<conversationId>` badge;
Workspace details in their menu opens the Workspaces panel. The shown row is highlighted, also while one of its
subagents is shown. Each row has its title (or `#id` for shared rows, `Untitled conversation` for isolated rows)
and the time of its latest message (`now`, `5m`, `3h`, `2d`,
then a date). Its leading mark pulses while it or any of its subagents works, and is solid when an answer arrived
since you last looked at it. Actual foreground tasks and live run boundaries determine Working, not the potentially
lagging title/timestamp list.
A solid purple dot means an unread reply, not ongoing work; only the pulsing dot means working.

Every row reads one state from board's `conversationState`, the same the System surface shows: working;
**waits on you** (only the primary agent, @ultimate or @sync in the machine home: an open question to the user);
**awaiting @ultimate** (amber question mark: an open reply-expected message the conversation sent another agent);
**done** (green check, subagents only: it answered, and its answer went to its parent); **failed** (red cross: its
latest input ended unanswered); else idle. Nothing here is a model's opinion of a reply.

A conversation with genuinely owned children has an expandable Sub-agents group; a listed root shows none, since a
root runs no turns and its children predate its tally (they stay reachable by link and search). Rows show the recorded agent role/name,
actual Working/Queued/Idle/Replied/Run failed state, and a brief what-it-did description from its latest assessed reply.
Replied means a run answered, not that its goal is fulfilled. During new work, an old activity is labeled Last reply.
A child linked to a plan task leads with the plan's `TaskChip` and shows the task title instead of its activity.
A row switches to its child, highlights selection and keeps the top-level summary visible. History forks are not
invented delegation edges. Expansion is persisted in `ext.conversations.expanded`; buttons support keyboard access.

@ultimate starts coordinator branches; there are no manual creation commands or isolation preferences. The sidebar
header's Workspaces button opens the read-only checkout panel.
Conclude releases clean, fully landed checkouts, including owned subagent checkouts. Uncommitted files,
unlanded commits, and busy checkouts are kept.
The Workspaces panel shows checkouts read-only.

On hover or focus, a row's `…` menu offers Rename (inline; also on double-click; Enter or leaving the field saves,
Escape cancels, and after either key focus returns to the row), Compact context (keeps the gist and frees context;
disabled while the conversation works), and Conclude. Before concluding, the UI calls workspaces `pending {ids}`.
When a conversation or its subagents have uncommitted files or unlanded commits, a confirmation dialog names the
work and explains that its checkout is kept until the work lands or is discarded. Otherwise it concludes at once.
Concluded rows and their branches/subagents sit in a collapsed "Concluded · N" group at the bottom.
Resume brings them back. Any input that starts a run in a concluded conversation (typed input, a board message or
reply, a subagent report, an automation's message) resumes it and its concluded ancestors in the commit that places
the input, through the patched `GenerationTask.beforeInput` hook. Notes and other writes start no run and resume nothing.
Concluding the shown subtree shows another live conversation when one exists.

Commands, under Conversations: `conversations.summary-model` ("Summary model…", see [Summary model](#summary-model)). The UI state keeps concluded
ids in `ext.conversations.concluded` and, in `ext.conversations.seen`, the latest answer time seen per top-level
conversation; a conversation not recorded there counts as seen.
