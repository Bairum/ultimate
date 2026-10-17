# Board

Durable messages between conversations, standing agents and the user. Built in and on by default.

## Messaging

`message { to, text, reply?: true, steer?: false }` returns the message id immediately. Address a conversation
as `#123` or `123`, a standing agent as `@name`, the project's existing lander as `@lander`, or the inbox as `user`.
Self-messages, unknown conversations and tallies are refused; use `note` for a tally. Unknown standing names list
the valid ones. Standing agents are resolved and configured through the `subagents` service at delivery admission.

An idle recipient wakes. A busy one receives a follow-up after its current run, or steering during that run with
`steer: true`. The typed `board.message` input identifies its sender and explains where its answer goes. Its `delivery`
field records `steer` or `followUp`.
The answer returns as `board.reply`, steering the sender. An unanswered input produces a failure reply instead.
Answer directly rather than messaging the sender: the tool refuses reply-enabled messages back to a sender whose reply-enabled message is still unanswered, while `reply: false` updates and other recipients remain allowed.
A subagent (a conversation its parent lists in `ultimate.subagents`) may message only that parent, so its work reaches
the user through its coordinator and @ultimate; its prompt says so. Automation runs and top-level conversations may
message anyone.
`reply: false` is one-way: it wakes the recipient without returning an answer, and its model text says the
answer is not sent. The log records its answering assistant entry in `answer` while keeping state `delivered`;
no reply is appended. A subagent's one-way update to its parent is instead a `board.message` write with
`delivery: 'note'` and no `input` flag. It starts no run; the parent reads it with its next model request.
The note's delivery decision is saved in the task input for replay. Sending to `user` only writes an
unread inbox item; it starts no run. Replies to a user post also stay in the inbox without starting a run.
A reply-enabled message to `user` stays open, and its sender shows as awaiting reply, until the user answers it:
a Reply, any new post to the sender, an answer card, or a plain input typed in the sender's conversation
marks it answered. Posts commit the change with the message; typed inputs close it through a commit
subscription, only for questions asked before that input.

Reply-expected agent messages to `user` also request question extraction in the append transaction through the
optional questions service. The sender's outgoing `message` card in its transcript shows extracted decisions
under the message body while it is open: Yes/No or choice buttons with a recommended marker, plus Something
else. The Board feed shows no card. The user-only questions `answer` action posts
a normal user Board reply with `re` and Q/A text, waking the sender. Its admission atomically checks that the
original message is still open, preventing duplicate replies. A Reply, a new post or typing in the sender's
conversation closes the card too.
One-way messages and user posts never request extraction; see [Questions](../questions/README.md).

In the sender's transcript a `message` call renders as an outgoing card: recipient, one-way or expects reply, and
the message's live state from the board log (sending, delivered, in your inbox, awaiting reply, answered, failed),
with a link to the Board or the recipient's entry. A `branch` call renders as a branch-start card: the branch's
feature and title, its root, isolated or shared, working or reported back, an Open link to its first input, and
the prompt. Failed calls of either tool keep the generic tool card with their error.

The message tool is replay-safe: it memoizes the sent id. A task-scoped `board.sent` receipt commits with the
message and delivery task, preventing a duplicate even if interrupted before the memo is saved.
Delivery is a background durable task owned by the root conversation. Stable request ids (`board:<id>` and
`board-reply:<reply-id>`) deduplicate submissions across reopen. Recording the answer, appending its reply and
advancing the task checkpoint happen in one transaction. A reopened task resumes that checkpoint, so both a
placed input awaiting an answer and a recorded answer awaiting delivery survive without duplicate replies.
One-way input deliveries also wait for the answer; recording it and completing the task commit together.
Note deliveries complete after placement, without waiting for an answer.

## Ultimate and branches

Talk to `@ultimate` on the board to start and steer work. It is the built-in standing orchestrator, not a coding worker.
Model-facing messages identify standing senders as `#12 (@ultimate)` and the lander as `#40 (@lander)`; ordinary
conversations stay `#id`, and user posts say `user`. Before delivery, standing recipients are refreshed from their
current definitions, including numeric-address messages and automatic replies.

The deferred `branch { prompt, root?, isolated?: true }` tool is offered only to definitions that name it.
It chooses the explicit root, otherwise the caller's tree root, otherwise the only root. Ambiguous or missing roots
produce an error listing the available ids. It forks the root's tally tip through lineage, attributes the tally prompt
to the caller, and sends the first input as a board message with replies enabled. It returns the branch id and message id.
The branch's answer therefore wakes its caller as a normal `board.reply`.
Before sending its first input, the tool rereads the `coordinator` definition (built-in, user, then trusted project override), applies only its instructions, and marks `ultimate.metadata.label = 'coordinator'`. The branch keeps its inherited model and tools. Coordinators report decisions to @ultimate and send it one-way landing or failure updates with the sha and divergence.
The tool gives lineage its task and call ids for a task-scoped receipt, recorded atomically with the fork, so replay cannot
create another branch even before the branch-id memo is saved. Pi retires that receipt when the originating task completes.
It deduplicates message admission with the same task-scoped `board.sent-calls` receipt as `message`, indexed by call id
so nested codemode calls stay distinct.

Ultimate's answers to the user's board posts reach the inbox through the ordinary reply path. Other answers stay
in its conversation. To relay a branch result, decision or landing to the user, Ultimate sends one consolidated
`message {to: 'user', text}` when the needed replies have arrived.

## Document and typed inputs

`Board` (kind `board`, version 1) is exported on `ROOT_CONVERSATION_ID`:

```ts
{ messages: BoardMessage[]; next: number; readUpTo: number }
```

`next` starts at 1; `readUpTo` starts at 0. The log keeps the newest 300 items; transcripts retain delivered inputs.
An unread inbox item has `to === 'user' && id > readUpTo`.

```ts
type BoardMessage = {
  id: number
  from: number | 'user'
  to: number | 'user'
  text: string
  at: number // Unix milliseconds
  reply: boolean
  re?: number
  kind?: string
  state: 'sent' | 'delivered' | 'answered' | 'failed'
  entry?: EntryId
  answer?: EntryId
  error?: string
}
```

`board.message` data: `{ id, from, text, reply, delivery: 'steer' | 'followUp' | 'note' }`.
`board.reply` data: `{ id, re, from, text, failed }`. A reply has its own id and `re` points to the original message.
The reply's `answer` links to the recipient's assistant entry; the original also stores its input `entry`.

## Actions

- `post({ to: string, text: string, re?: number }) → { id: number }`: posts as `user`, with replies enabled.
- `read({ upTo: number }) → {}`: advances the read mark monotonically, capped at the latest allocated id.
- `addresses({}) → { agents, lander?, conversations }`: resident names/descriptions with an id if already created,
  the existing project lander id, and up to 50 recent top-level conversation summaries (including title and label).

`post` and `read` are user-only actions: codemode cannot impersonate the user or mark their inbox read.
Agents use the `message` tool instead. The prompt section is stable and lists resident names and descriptions.

## Service

`host.use<BoardService>('board')` exposes:

```ts
record(tx: Tx, input: {
  from: number | 'user'
  to: number | 'user'
  text: string
  kind?: string
  entry?: EntryId
}): Promise<number>
```

It appends a delivered, one-way log item in the caller's transaction, without submitting an input or starting a run.
Other extensions use this for events such as landings. Import the service type from `server.ts`.

## UI

The participants rail above the feed lists you (with unread count), standing agents, the existing lander, and unconcluded coordinators. Other top-level conversations with board messages appear too. It scrolls horizontally on phones. Status dots show working (busy), subagents working (idle while a subagent below it, at any depth, works; the
same walk as the phase chip's Waiting), needs input (a current overview assessment), awaiting reply (an open reply-enabled outgoing message), or idle, alongside the latest conversation or board activity time. Click a participant to filter both directions; click again or Clear to restore the feed. Open / #id opens its conversation, and Mention addresses the composer.
The filter replaces the feed's caption with who waits on whom: for you, how many open questions wait on you and how
many of your posts await an answer; for anyone else, how many of its questions wait on you, how many of yours it
owes, and its open requests with others when there are any.

The conversations sidebar sits beside the Board as on Agent (`mod+b`, an overlay on phones). Picking a conversation
there opens it on the Agent surface.

The Board surface shows all traffic oldest first, or just your Inbox, as a chat seen from one participant: you, or
the participant the feed is filtered to. Its own messages sit on the right, what it receives on the left, and traffic
between others on the left too, quieter (no fill, slightly narrower) and naming both sides. Every sender has a stable
accent (you the brand colour, others a small palette by id) shown as the bubble's stripe, a faint fill and the sender
name; on phones bubbles take the full width and only the stripe's side tells them apart. Opening Inbox marks its
messages read; a quiet `inbox N` status-line button appears on every surface while messages are unread. Bubbles show
the sender, the recipient unless it is the perspective, time, reply quotes and an Open link when the transcript entry
is known. Their footer says who waits on whom: an open question to you is an amber “awaiting your reply”, other open
requests say “waiting on #x” (naming the sender unless it is the perspective), then answered, one-way, reply, landing,
sending or failed. Landing items use a merge icon.

Start a post with `@agent` or `#conversation`; autocomplete lists resident agents, the lander and recent conversations.
Without an address, posts go to `@ultimate` when it exists. Enter sends on desktop (Shift+Enter inserts a newline);
on touch keyboards, return always inserts a newline and the arrow button sends. Reply retains a link to its original
message. Typed board messages and replies render as compact transcript cards with Source / Return navigation.
Incoming messages show whether they expect a reply or are one-way, plus their delivery mode (steered, follow-up or
note) when recorded. Final answers name their reply destination, or say “not sent” for a one-way message. Answers
that cover several board messages list each destination; unrelated answers show no board label.
