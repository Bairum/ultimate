The project's conversations in the Agent surface's sidebar: list, create, switch, rename, clear, and archive them.
Several run at once, each a separate agent, and each knows about the others. GPT-6 Luna automatically gives top-level
conversations concise titles and sidebar summaries, and assesses each final reply without changing the main agent.

## Sidebar

The sidebar lists the top-level conversations that have a message, newest input first, so a row moves when its
conversation gets input (your message or a background subagent's report), not while it works. Empty conversations stay
out, except the shown one: an empty shown conversation is the draft, listed first as "New conversation". The shown row
is highlighted, also while one of its subagents is shown. Each row has its title (or `#id`) and the time of its latest
message (`now`, `5m`, `3h`, `2d`, then a date). Its leading mark pulses while it or any of its subagents works, and is
solid when an answer arrived since you last looked at it. Actual foreground tasks and live run boundaries determine
Working, not the potentially lagging title/timestamp list. While working, old assessment marks are suppressed.

Idle, currently assessed replies may show a circular question (needs input) or green circular check (Done). These are
**Luna assessments, not verified completion**; the tooltips say so. For a child, a question means it needs
coordinator/input, not necessarily a human. Unknown, neutral, stale or failed assessments never show a success mark.
There is no third red blocked/unfinished assessment.

A conversation with genuinely owned children has an expandable Agents group. Rows show the recorded agent role/name,
actual Working/Queued/Idle/Replied/Run failed state, and a brief what-it-did description from its latest assessed reply.
Replied means a run answered, not that its goal is fulfilled. During new work, an old activity is labeled Last reply.
A row switches to its child, highlights selection and keeps the top-level summary visible. History forks are not
invented delegation edges. Expansion is persisted in `ext.conversations.expanded`; buttons support keyboard access.

New conversation (the button, `mod+alt+n`, or the palette) shows an empty conversation on the Agent surface and
focuses the composer. It reuses the shown draft (a shown top-level conversation without entries), else the newest
empty, untitled, idle, unarchived conversation, and creates one only when there is none. From a top-level conversation
it takes that one's model and thinking level; from a subagent it sets none, so a reused conversation keeps its own and a
new one gets the main conversation's.

On hover or focus, a row's `…` menu offers Rename (inline; also on double-click; Enter or leaving the field saves,
Escape cancels, and after either key focus returns to the row), Clear context… (asks first; not while the conversation
itself works, as the server refuses), and Archive. Archived rows sit in a collapsed "Archived · N" group at the bottom,
where Unarchive brings them back; archiving the shown row shows the next one.

Commands, under Conversations: `conversations.new` ("New conversation", `mod+alt+n`) and `conversations.reset`
("Clear the context" of the shown top-level conversation, when it is idle and has entries). The UI state keeps archived
ids in `ext.conversations.archived` and, in `ext.conversations.seen`, the latest answer time seen per top-level
conversation; a conversation not recorded there counts as seen.

## Server facet

The `conversations` prompt section goes to every top-level conversation (neither a subagent nor a fork). It names the
conversation's own id and lists the other top-level conversations that have a message and are not archived (the web
keeps archived ids in the UI state `ext.conversations.archived`): at most the 10 most recently active, listed by id,
each as `#<id> <title or "untitled">` with its cwd when that differs. It holds no busy state or times, so it changes
only when that list, a title, or a cwd does, and prompt caches stay warm. It reminds the agent that the others share the
checkout unless a cwd says otherwise, and how to look at them with codemode's `ultimate.entries(id)` and
`ultimate.taskGraph()`. Without other conversations there is no section.

Actions, each on a top-level conversation; bad args, unknown conversations, subagents, and forks throw:

- `rename {id, title}`: sets the `ultimate.metadata` title, with whitespace runs (newlines too) collapsed to one space,
  trimmed, and cut to at most 160 characters; a blank title removes it, so the first message names the conversation
  again and re-enables automatic titles on the next scheduled summary. Nonblank renames take manual ownership, even
  during generation. Returns `{ ok: true }`.
- `reset {id}`: clears the conversation with a Durable reset (a `pi.reset` entry starts a new, empty context). It
  refuses while the conversation works. A conversation named by its first message keeps that name as its title.
  Returns `{ ok: true }`.

## Automatic summaries and reply assessments

Each completed user/assistant reply, including an owned child's reply, admits a conversation-owned Pi background task
requesting `openai-codex/gpt-6-luna` with medium reasoning. On a top-level conversation's first exchange, then after each
three further exchanges (1, 4, 7, …), that same request also generates title and summary—never a duplicate request.
A due summary displaced by newer work remains owed and combines with the next current reply. It never changes the
main agent's model, creates a child conversation, polls for idle time, or triggers on tools/stream chunks. The yield
hook durably admits work, and the task waits for the final answer and a settled input before advancing the cadence.
Counting and task advancement share one atomic commit, before context preparation, so an older slow context read
cannot lose a distinct completed exchange or count it twice on recovery.
Owned children receive assessment/activity only; their assignment titles are preserved. Ownerless history forks and
intermediate yields continued by another hook are excluded. Older delayed observers still count, but cannot replace a
newer reply's assessment. Existing conversations start
counting at their next completed exchange; there is no historical backfill.

The request includes only recent user/assistant text (at most 2,400 characters per message and 12,000 total), plus the
previous brief summary. Tools, images and thinking are omitted. JSON must contain an assessment (`needs_input`, `done`
or `neutral`) and meaningful activity (at most 160 characters). Unknown/unapproved outcomes are rejected, not converted
to success. When due, it must also contain a 3–7-word title (at most 80 characters) and a brief 1–2 sentence summary
(at most 420 characters). Requests use a 2,048-token output
option, cancel text output over 2,048 characters, and time out after 60 seconds. **Pi's Codex adapter does not forward
`maxTokens` to the provider, so the option is not a provider-side reasoning-token ceiling.** There is no silent model
substitution. Failed or malformed responses preserve the last good summary and show a quiet unavailable status;
the next completed reply retries. There is no timer retry. Results require matching input/answer identities and idle,
visible context; queued/new input, reset, compaction or superseding work prevents stale assessments from applying.

`ultimate.conversation-summaries` is a conversation document holding the summary, generated-title provenance,
manual ownership, completed-exchange count, last yield/answer, reset revision, pending task id, an owed-summary flag,
assessment status, stamped assessment and bounded activity. Its latest state
survives facet reloads and process restarts; an unfinished durable task resumes, with a memoized response reused once
stored. A crash before the response is memoized can repeat the request. Generated titles use `ultimate.metadata` and
can update. HTTP submit marks a newly created first-input fallback with `ultimate.metadata.titleSource: 'input'`
in the same transaction that creates the title; it never marks an existing title. Generated replacements and explicit
renames clear that marker atomically. Accepting an unchanged title in the rename field still takes manual ownership.
Unmarked/preexisting metadata titles are never inferred to be fallbacks or replaced, even when they equal the first
input; there is no historical backfill. A blank rename removes metadata
and restores automatic naming; until the next summary, the first-message title is shown.

Clear context keeps the title, clears the summary/assessment/activity and resets the cadence. A revision and pending-task check reject
in-flight results from the old context or a superseded request. A response made stale by compaction clears only its
own pending status and preserves the last valid summary; it cannot clear a superseding request. Background work does
not hold up answers or ordinary idle/reset operations. The sidebar shows only the selected top-level summary, also
when its child is selected.

## Shared sidebar index

`ultimate.conversation-overview`, written only on reserved root conversation #1, contains `conversations[id]` rows:
`parentId` (actual owner conversation, not history ancestry), `role` (metadata label), `runState`
(`working | queued | idle | done | error`), active `inputId`/`answerId`, `summary`/`summaryStatus`, `activity`,
`assessmentStatus`, and optional `assessment: { inputId, answerId, value: needs_input | done | neutral }`.
`runState: done` is displayed as Replied; assessment Done is explicitly model opinion. A current assessment projects
its settled submission's input entry id, not a synthetic continuation's transcript user entry. The latest transcript
user still guards freshness, so new input invalidates old assessments. Existing conversation summaries already supply
titles, timestamps and owner task ids, so these are not duplicated in the index.

One root-document SSE serves every row, unchanged by expansion/selection; no per-row or selected-owner streams.
On open/reload, the extension reads task receipts and each conversation's newest visible user entry to reconstruct
actual state without paid backfill. Thereafter it reconciles only affected rows from meaningful commit publications:
input/submission changes, run boundaries/terminal receipts, role changes, resets/compactions and summary/assessment
commits. Live generation/tool chunks are ignored, and index commits do not feed themselves back into reconciliation.
Facet cleanup releases the listener and drains outstanding work.
