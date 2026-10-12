The project's conversations in the Agent surface's sidebar: list, create, switch, rename, clear, and archive them.
Several run at once, each a separate agent, and each knows about the others. GPT-6 Luna automatically gives top-level
conversations concise titles and sidebar summaries, and assesses each final reply without changing the main agent.

## Sidebar

The sidebar lists the top-level conversations that have a message, newest input first, so a row moves when its
conversation gets input (your message or a background subagent's report), not while it works. Empty conversations stay
out, except the shown one and every isolated draft (including pending, failed and removed checkouts): an empty shown
conversation is the draft, listed first as "New conversation". Isolated rows carry a short `W<conversationId>` badge;
Workspace details in their menu opens the Workspaces panel. Empty isolated rows also have the management menu. The shown row
is highlighted, also while one of its subagents is shown. Each row has its title (or `#id`) and the time of its latest
message (`now`, `5m`, `3h`, `2d`, then a date). Its leading mark pulses while it or any of its subagents works, and is
solid when an answer arrived since you last looked at it. Actual foreground tasks and live run boundaries determine
Working, not the potentially lagging title/timestamp list. While working, old assessment marks are suppressed.

Idle, currently assessed replies may show a circular question (needs input) or green circular check (Done). These are
**Luna assessments, not verified completion**; the tooltips say so. For a child, a question means it may need its
coordinator, not necessarily a human. Unknown, neutral, stale or failed assessments never show a success mark.
There is no third red blocked/unfinished assessment.

A conversation with genuinely owned children has an expandable Agents group. Rows show the recorded agent role/name,
actual Working/Queued/Idle/Replied/Run failed state, and a brief what-it-did description from its latest assessed reply.
Replied means a run answered, not that its goal is fulfilled. During new work, an old activity is labeled Last reply.
A row switches to its child, highlights selection and keeps the top-level summary visible. History forks are not
invented delegation edges. Expansion is persisted in `ext.conversations.expanded`; buttons support keyboard access.

New conversation (the button, `mod+alt+n`, or the palette) shows an empty conversation on the Agent surface and
focuses the composer. It reuses the shown draft (a shown top-level conversation without entries), else the newest
empty, untitled, idle, unarchived **shared** conversation, and creates one only when there is none. It never reuses
an empty isolated conversation, including the shown one. From a top-level conversation
it takes that one's model and thinking level; from a subagent it sets none, so a reused conversation keeps its own and a
new one gets the main conversation's.

The New options menu also offers New isolated conversation through the workspaces extension's `create` action.
Creation never submits input or runs a model. Setup errors are inspected in Workspaces; start a new conversation to try again.
Ordinary New keeps its shared-draft behavior. Archive and clear context never remove checkouts or commits.

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

The `GenerationTask.onYield` hook schedules a background observer. It waits for generation to settle and
only counts an exchange when an input submission completed with that answer (not an intermediate yield).
Luna assesses each completed reply, including subagent replies, in a background task with medium reasoning.
Top-level conversations also get a title and summary on exchanges 1, 4, 7, and so on, in the same request.
A summary delayed by newer work is included with the next current reply. Tools and partial replies do not trigger it.
The request reads recent user/assistant text and the previous summary, not tools, images or thinking.
It times out after 60 seconds. Assessment, activity, title and summary are checked and shortened for display.
Assessments describe the reply, not verified completion. New work, reset or compaction can make a result stale.
Subagents get assessments and activity only; history forks are excluded.
Luna can name an untitled conversation or update its own last generated title.
API titles, renames and creator-given labels are kept. A blank rename restores automatic naming.
Each accepted automatic title change appends a `conversations.title-changed` entry with `{ title, at }`
(`at` is Unix milliseconds), atomically with the metadata update and task settlement. The transcript displays
“Title changed to …” with the local time and a full-date tooltip. This is an automatic system action, not an
agent-triggered tool or model message. Unchanged titles, protected manual titles, stale results, failures and
unavailable Luna produce no action. Entries survive reload/restart without duplication; old changes are not
backfilled and manual renames are not logged.
Clear context keeps the title, clears summary and assessment, and restarts the cadence.
The task saves the provider response before parsing it and adds reported usage even for stale or invalid results.
Replaying a saved response does not count it again. Crashing before it is saved can repeat the request.
State survives reloads and restarts. Failed requests preserve the last summary and retry on the next reply.
When Luna is unavailable in the model runtime, summaries and assessments are skipped quietly, without a task.

## Shared sidebar index

`ultimate.conversation-overview` keeps sidebar rows in the root conversation document.
Rows include run state, summaries, activity and assessments tied to their input and answer.
Replied means an answer arrived; Done is Luna's opinion, not proof of completion.
One root-document stream serves all rows. Titles, timestamps, child links and agent labels come from the core
conversation list.
On open, the extension rebuilds rows from stored conversations without requesting old assessments.
Afterwards it updates affected rows when work or summaries change, ignoring live stream chunks.
