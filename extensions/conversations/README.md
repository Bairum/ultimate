The project's conversations in the Agent surface's sidebar: talk to @ultimate, switch, rename, clear, and conclude them.
Several branches run at once as separate agents; lineage roots keep their shared tally without running turns.
A summary model (GPT-6 Luna by default) automatically gives top-level conversations concise titles and sidebar summaries, and assesses each final reply without
changing the main agent.

## Sidebar

Ownerless top-level standing agents (label `agent`) are pinned with the lander, sorted by ID, and cannot be concluded or hidden.

The sidebar pins the lander above the roots (lineage's `useRoots()`), each marked with a branch icon and `root`;
trees sort by their newest input anywhere in them.
Branches nest under their source (`branchOf.conversationId`), with a hairline guide and one indent per depth;
siblings sort by latest input. Older conversations that are neither roots nor branches live in the collapsed
"Earlier · N" group, above "Concluded · N". Isolated rows carry a short `#<conversationId>` badge;
Workspace details in their menu opens the Workspaces panel. The shown row is highlighted, also while one of its
subagents is shown. Each row has its title (or `#id` for shared rows, `Untitled conversation` for isolated rows)
and the time of its latest message (`now`, `5m`, `3h`, `2d`,
then a date). Its leading mark pulses while it or any of its subagents works, and is solid when an answer arrived
since you last looked at it. Actual foreground tasks and live run boundaries determine Working, not the potentially
lagging title/timestamp list. While working, old assessment marks are suppressed.
A solid purple dot means an unread reply, not ongoing work; only the pulsing dot means working.

Idle, currently assessed replies may show a circular question (needs input) or green circular check (Done). These are
**summary model assessments, not verified completion**; the tooltips say so. For a child, a question means it may need its
coordinator, not necessarily a human. Unknown, neutral, stale or failed assessments never show a success mark.
There is no third red blocked/unfinished assessment. Assessments never trigger question extraction or answer
cards; [questions](../questions/README.md) extracts only from reply-expected Board messages to the user and from
@ultimate's final answers to typed input.

A conversation with genuinely owned children has an expandable Sub-agents group. Rows show the recorded agent role/name,
actual Working/Queued/Idle/Replied/Run failed state, and a brief what-it-did description from its latest assessed reply.
Replied means a run answered, not that its goal is fulfilled. During new work, an old activity is labeled Last reply.
A child linked to a plan task leads with the plan's `TaskChip` and shows the task title instead of its activity.
A row switches to its child, highlights selection and keeps the top-level summary visible. History forks are not
invented delegation edges. Expansion is persisted in `ext.conversations.expanded`; buttons support keyboard access.

The sidebar's **Talk to @ultimate** button opens the standing agent on the Agent surface through
`subagents.standing {name: 'ultimate'}`. @ultimate starts coordinator branches; there are no manual creation commands
or isolation preferences. A separate Workspaces button opens the read-only checkout panel.
Conclude releases clean, fully landed checkouts, including owned subagent checkouts. Uncommitted files,
unlanded commits, and busy checkouts are kept; Clear context never removes checkouts or commits.
The Workspaces panel shows checkouts read-only.

On hover or focus, a row's `…` menu offers Rename (inline; also on double-click; Enter or leaving the field saves,
Escape cancels, and after either key focus returns to the row), Clear context… (asks first; not while the conversation
itself works, as the server refuses), and Conclude. Before concluding, the UI calls workspaces `pending {ids}`.
When a conversation or its subagents have uncommitted files or unlanded commits, a confirmation dialog names the
work and explains that its checkout is kept until the work lands or is discarded. Otherwise it concludes at once.
Concluded rows and their branches/subagents sit in a collapsed "Concluded · N" group at the bottom.
Resume brings them back; sending to a concluded branch resumes it and any concluded ancestors automatically.
Concluding the shown subtree shows another live conversation when one exists.

Commands, under Conversations: `conversations.reset`
("Clear the context" of the shown top-level conversation, when it is idle, has entries and is not a listed root), and
`conversations.summary-model` ("Summary model…", see [Summary model](#summary-model)). The UI state keeps concluded
ids in `ext.conversations.concluded` and, in `ext.conversations.seen`, the latest answer time seen per top-level
conversation; a conversation not recorded there counts as seen.

## Server facet

`activity.ts` maintains `ultimate.metadata`'s `inputTitle`, `inputAt`, and `answerAt` from committed
history; core only serves those fields, preferring an explicit `title` over the input title. Reset and
compaction cut the active title source but preserve activity times from earlier history. On open, the
projection reconciles every conversation, including inherited fork history, and only commits metadata
when the derived fields change.

All input detection uses `isInput` in `activity.ts`: Pi Durable marks entries placed from input
submissions with `input: true` (a small upstream patch). Pi's own `pi.user` input kind also counts,
keeping existing history usable. Typed inputs count without an extension kind list; user-role writes
such as lineage notes do not.

The `conversations` prompt section goes to every top-level conversation (not a subagent). It names the
conversation's own id and lists the other top-level conversations that have a message and are not concluded (the web
reads server-owned concluded ids from UI state `ext.conversations.concluded`): at most the 10 most recently active, listed by id,
each as `#<id> <title or "untitled">` with its cwd when that differs. It holds no busy state or times, so it changes
only when that list, a title, or a cwd does, and prompt caches stay warm. It reminds the agent that the others share the
checkout unless a cwd says otherwise, and how to look at them with codemode's `ultimate.entries(id)` and
`ultimate.taskGraph()`. Without other conversations there is no section.

Actions are callable from the browser with `api.action` or by agents with
`await ultimate.action('conversations', 'conclude', {ids: [N]})` in codemode. The browser never rewrites the concluded
list. No state-key migration runs automatically.

- `conclude {ids:number[]}`: validates top-level conversations (unknown ids and subagents throw), deduplicates and
  adds them to `ext.conversations.concluded` in one transaction, then calls workspaces `release`. Returns
  `{ concluded: number[], kept: {id, uncommitted, unlanded, busy?}[] }`; `kept` explains which checkouts remain.
- `resume {ids:number[]}`: transactionally removes ids and their concluded ancestors from the list, returning
  `{ resumed: number[] }` for the removed ids. The next input recreates a released checkout from the target tip;
  Resume itself does not create one.

The single-conversation actions below reject bad args, unknown conversations, and subagents:

- `rename {id, title}`: sets the `ultimate.metadata` title, with whitespace runs (newlines too) collapsed to one space,
  trimmed, and cut to at most 160 characters; a blank title removes it, so the first message names the conversation
  again and re-enables automatic titles on the next scheduled summary. Nonblank renames take manual ownership, even
  during generation. Returns `{ ok: true }`.
- `reset {id}`: clears the conversation with a Durable reset (a `pi.reset` entry starts a new, empty context). It
  refuses while the conversation works. A conversation named by its first message keeps that name as its title.
  Returns `{ ok: true }`.

## Automatic summaries and reply assessments

Title/summary requests also classify a 1–3 word product feature label for top-level conversations.
The label is kept unless the work clearly moves to another feature, exposed in the overview, and cleared by Clear context.

All three triggers request work through the typed, transaction-scoped `requestSummary(tx, host, id, request)`
helper in `summary.ts`: `intent`, `spawn`, and `reply`. The existing version-1 task inputs/checkpoints are preserved;
initial intent adds an optional input field, so live reply and spawn tasks remain resumable.

`GenerationTask.beforeRequest` requests an initial title and intent summary before the main model request.
It inspects the conversation's own stored entries since the current head marker (not inherited fork history):
exactly one user input and no assistant reply, only in top-level conversations. A durable `intentRequested` flag prevents tools, request retries and recovery
from requesting it again. Established conversations are not backfilled on later inputs, including when the summary
model becomes available later. Clear context removes the flag so a new context can request its own intent.
Intent describes the requested goal, not completed work; it can publish while the main agent is busy.
It does not assess a reply, increment exchanges, or consume the 1/4/7 cadence. New input (including queued input),
a reset, or a superseding spawn/reply request makes a held result stale; compaction does not.
Accepted intent appends `conversations.intent-summarized` with `{ summary, model?, at }` (Unix milliseconds),
atomically with summary/title acceptance and task settlement. The transcript shows a quiet “Intent: …” row with local time
and a full-date tooltip. This custom system entry has no model contribution; it survives replay without duplication.

The `GenerationTask.onYield` hook schedules a background observer. It waits for generation to settle and
only counts an exchange when an input submission completed with that answer (not an intermediate yield).
The [summary model](#summary-model) assesses each completed reply, including subagent replies, in a background task.
Top-level conversations also get a title and summary on exchanges 1, 4, 7, and so on, in the same request.
For a top-level non-root conversation in a lineage tree, that same request produces an abstract after every completed
exchange, independent of the title/summary cadence. It uses the original branch intent, previous abstract and transcript:
Ask, Diverged (agreements, approach/library or scope changes, or none), State (including named commits), Areas and Open
questions, capped at 1200 characters. Acceptance calls the lineage service's `abstract` in the same transaction as the
reply assessment, with `at` pointing to the answer entry, and saves the text in summary state. A newer abstract updates
the open one in place until a landing freezes it (see the lineage README); the root never reorders. Roots, owned
conversations such as subagents, and conversations outside trees such as landers produce no abstract. Neither do
stale answers, failed or interrupted exchanges, or missing lineage or summary models. Exchange and intent detection use own entries, so inherited inputs and answers
do not count as the branch's work.
A summary delayed by newer work is included with the next current reply. Tools and partial replies do not trigger reply assessments.
Successful subagent creation additionally schedules a parent title/summary refresh in the creation transaction,
before either foreground waiting or background return. It describes the plan and delegation now starting, using
recent visible text plus the agent/task, without publishing a final-reply assessment or activity, counting an
exchange, or consuming the 1/4/7 reply cadence. The durable action receipt deduplicates replay; failed starts,
messages and waits do not schedule it. If conversations or the summary model is unavailable, child creation proceeds
without it.
Spawn refreshes share the summary task, response receipt and usage accounting. They may publish while the parent
is busy, but reset, newer input or a superseding summary request invalidates them; manual titles stay protected.
An accepted spawn refresh appends `conversations.summarized` `{ summary, model?, at }`, also when the title stays.
The request reads the original request (kept even when compaction removed it from context), recent
user/assistant text and the previous summary, not tools, images or thinking.
It times out after 60 seconds. Assessment, activity, title and summary are checked and shortened for display.
Assessments describe the reply, not verified completion. New work or a reset can make a result stale; only a reset ends an exchange.
Subagents get assessments and activity only; history forks are excluded.
The summary model can name an untitled conversation or update its own last generated title.
API titles, renames and creator-given labels are kept. A blank rename restores automatic naming.
Each accepted automatic title change appends a `conversations.title-changed` entry with `{ title, model?, at }`
(`at` is Unix milliseconds), atomically with the metadata update and task settlement. The transcript displays
“Title changed to …” with the local time and a full-date tooltip. This is an automatic system action, not an
agent-triggered tool or model message. Unchanged titles, protected manual titles, stale results, failures and
an unavailable summary model produce no action. Entries survive reload/restart without duplication; old changes are not
backfilled and manual renames are not logged.
Clear context keeps the title, clears summary and assessment, and restarts the cadence.
The task saves the provider response before parsing it and adds reported usage even for stale or invalid results.
Replaying a saved response does not count it again. Crashing before it is saved can repeat the request.
State survives reloads and restarts. Failed requests preserve the last summary and retry on the next reply.
When the summary model is unavailable in the model runtime, summaries and assessments are skipped quietly, without a
task. A task that finds no available model before it chose one settles quietly too: no discard entry, no error status.

## Summary model

`summaryModel` in `~/.ultimate/settings.json` or the project's `.ultimate/settings.json` (project wins, and only once
the project is chosen) names the model for titles, summaries and reply assessments as
`provider/id[:thinking]`, an exact provider and model id with an optional Pi thinking level, clamped to what the model
supports (medium when omitted). Unset, it is `DEFAULT_SUMMARY_MODEL`: GPT-6 Luna with medium thinking through the
current OpenAI provider (including Sign in with ChatGPT). `summary-model.ts` reads it when a request is considered and again when a
task starts asking, so changes apply to the next request without a restart. Each task stores the resolved
`{ provider, id, thinking }` in its `model` memo before asking: a resumed task asks the same model even after the
setting changed. A malformed value shows one notice and turns summaries off; a well-formed model that is unknown or
not logged in skips quietly. Usage counts under the response's `provider/model`.

The "Summary model…" command opens a picker of logged-in models (rows from the models extension's picker) that shows
the effective value and its source (default, `~/.ultimate/settings.json`, or the project's settings). Picking a model,
or Use the default, writes only the user file, never the project's tracked `.ultimate/settings.json`. While project
settings decide the model, the dialog says "set by project settings", disables picking and Use the default, and its
footer names the project file to edit. Two actions back it:

- `summaryModel` → `{ value, source: 'default' | 'user' | 'project', default, path? }`; `path` is the project file
  when it decides the value.
- `setSummaryModel {value}`: a `provider/id[:thinking]` string, or `null` to remove it; returns the new effective
  setting. It refuses while a project setting applies. Writes reuse onboarding's atomic settings writer
  (`extensions/onboarding/settings.ts`).

`summary-model-ref.ts` parses the value without node imports, so the web facet shares it: only a recognized final
thinking level is stripped, so model ids may contain colons (`x-ai/grok-4.3:batch:high`).

It provides the `conversations` service: `subject(id)` returns a conversation's current title, summary and feature,
which workspaces snapshots for each submission. `concluded(caller)` returns a `Promise<Set<ConversationId>>`
from the server-owned concluded list, used by workspaces to release checkouts on open.

## How status and summaries flow

Every displayed status traces back to committed Pi Durable records. Hooks and tasks write records; documents are
projections that can be rebuilt from those records at any time; no process-local state decides what a row shows.

```text
GenerationTask hooks ─▶ conversations.summary task ─▶ entries + Summaries doc ─┐
 (beforeRequest, onYield)   (byTaskId on its entries)                          ├─▶ Overview doc ─▶ sidebar
input submission (done/unanswered) · pi.live · pi.inbox · pi.reset ────────────┘
```

- **Exchange**: the input submission placed last in the transcript (greatest entry id), read newest first with the
  host's `scanSubmissions`. A newer steer can be placed before an older queued follow-up, so the scan keeps reading a
  bounded window of older submissions past the first placed one. `done` carries its `answer`: the row is `answered`,
  with or without a summary model. `unanswered` is `error`, except when the user aborted it or a reset or stale write
  ended it. A later `pi.reset` entry ends the exchange; compaction does not.
- **Run state**: `pi.live.run` is `working`; a user item in `pi.inbox` is `queued`.
- **Summary task outcomes** are entries appended in the commit that settles the task, so each carries `byTaskId`
  (the summary task, whose input names the generation it observed). None contributes to the model context:
  - `conversations.assessed` `{ inputId, answerId, value, activity, model?, at }`: an accepted reply assessment.
  - `conversations.summary-discarded` `{ reason: 'stale' | 'error', cause, model?, at }`: a received result superseded
    by newer work or a reset (`stale`), or a failed or aborted request (`error`). A task superseded before it asked the
    summary model leaves no entry.
  - `model` is the `provider/model` the response names, else the summary model the task chose; absent only when no
    model was chosen.
  - `conversations.title-changed`, `conversations.intent-summarized` and `conversations.summarized`, as above, with
    `model` likewise.
    The transcript shows each as one quiet line with its local time.
- **Summaries** (`ultimate.conversation-summaries`) keeps the current summary, activity, assessment and their statuses
  (`pending`, `ready`, `stale`, `error`) plus the cadence. Stale shows nothing in the sidebar; error shows
  "unavailable · retries after next reply".

## Shared sidebar index

`ultimate.conversation-overview` keeps sidebar rows in the root conversation document.
Each row's `runState` is `working`, `queued`, `answered`, `error` or `idle`, with the input and answer ids of the
exchange, the summary, activity, and an assessment only while it belongs to that exact input and answer.
Answered means a reply arrived; Done is the summary model's opinion, not proof of completion.
One root-document stream serves all rows. Titles, timestamps, child links and agent labels come from the core
conversation list.
A commit only selects which rows to derive again: any committed submission, `pi.user`, `pi.reset` or `pi.compaction`
entry, `pi.live.run` or `pi.inbox` change, or `Summaries` change. Derivation reads the records themselves, so a row
built live equals the row a fresh open builds. On open, every conversation is derived anew without requesting old
assessments.
