# Board

Durable messages between conversations, standing agents and the user. Built in and on by default.

## Messaging

`message { to, text, reply?: true, steer?, images? }` returns the message id immediately. `images` forwards
images from the sender's own conversation, since a model cannot produce image bytes: `'latest'` takes the newest
entry with images, a number names that entry. The reference resolves when the message is admitted (at most
`maxImages`, each at most `maxImageBytes`; unknown entries or entries without images are refused); the log records
`images: { entry, count }`, and delivery attaches that entry's images to the recipient's input, so a replay attaches
the same ones. `branch` takes the same `images` for its first message. Messages to the user carry none.
Address a conversation
as `#123` or `123`, a standing agent as `@name`, or the project's existing lander as `@lander`.
Only the `ultimate` resident's standing conversation may message `user`; other senders must send @ultimate a one-way update to relay.
Self-messages, unknown conversations and tallies are refused; use `note` for a tally. Unknown standing names list
the valid ones. Standing agents are resolved and configured through the `subagents` service at delivery admission.

An idle recipient wakes. A busy one receives a follow-up after its current run, or steering during that run with
`steer: true`. `steer` defaults to `true` for @ultimate's messages, to any recipient including `@lander` and other
standing agents, and to `false` for everyone else; an explicit value always wins. The typed `board.message` input identifies its sender and explains where its answer goes. Its `delivery`
field records `steer` or `followUp`.
The answer returns as `board.reply`, steering the sender. An unanswered input produces a failure reply instead.
Answer directly rather than messaging the sender: the tool refuses reply-enabled messages back to a sender whose reply-enabled message is still unanswered, while `reply: false` updates and other recipients remain allowed.
A subagent (a conversation its parent lists in `ultimate.subagents`) may message only that parent, so its work reaches
the user through its coordinator and @ultimate; its prompt says so. Automation runs and top-level conversations may
message any agent; only @ultimate may message the user.
`reply: false` is one-way: it wakes the recipient without returning an answer, and its model text says the
answer is not sent. The log records its answering assistant entry in `answer` while keeping state `delivered`;
no reply is appended. A subagent's one-way update to its parent is instead a `board.message` write with
`delivery: 'note'` and no `input` flag. It starts no run; the parent reads it with its next model request.
The note's delivery decision is saved in the task input for replay. Sending to `user` writes a message
shown in @ultimate's transcript; it starts no run.
A reply-enabled message to `user` stays open, and its sender shows as awaiting reply, until the user answers it:
an answer card or a plain input typed in the sender's conversation marks it answered. Answer cards commit the
change with the reply; typed inputs close it through a commit subscription, only for questions asked before that input.

Reply-expected agent messages to `user` also request question extraction in the append transaction through the
optional questions service. The sender's outgoing `message` card in its transcript shows extracted decisions
under the message body while it is open: Yes/No or choice buttons with a recommended marker, plus Something
else. The user-only questions `answer` action posts
a normal user Board reply with `re` and Q/A text, waking the sender. Its admission atomically checks that the
original message is still open, preventing duplicate replies. Typing in the sender's conversation closes the card too.
One-way messages and user replies never request extraction; see [Questions](../questions/README.md).

In the sender's transcript a `message` call renders as an outgoing card: recipient, one-way or expects reply, and
the message's live state from the board log (sending, delivered, awaiting reply, awaiting your reply, answered,
failed), with an Open link to the recipient's entry. A `branch` call renders as a branch-start card: the branch's
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

Talk to `@ultimate` in its own conversation to start and steer work, using the top-bar @ultimate button or first sidebar row. It is the built-in standing orchestrator, not a coding worker.
Model-facing messages identify standing senders as `#12 (@ultimate)` and the lander as `#40 (@lander)`; ordinary
conversations stay `#id`, and user replies say `user`. Before delivery, standing recipients are refreshed from their
current definitions, including numeric-address messages and automatic replies.

The deferred `branch { prompt, root?, isolated?: true }` tool is offered only to definitions that name it.
It chooses the explicit root, otherwise the caller's tree root, otherwise the only root. Ambiguous or missing roots
produce an error listing the available ids. It forks the root's tally tip through lineage, attributes the tally prompt
to the caller, and sends the first input as a board message with replies enabled. It returns the branch id and message id.
The branch's answer therefore wakes its caller as a normal `board.reply`.
The tool records the caller in the branch's `board.started` document, so later answers reach it too. A later run, woken
by a subagent, a notify, a lander report or steering, ends with a final answer nobody receives. After each such run, a
background `board.route` task (one per generation, from an `onYield` hook) sends that answer to the starter as a one-way
board message from the branch, with the usual outgoing and incoming cards. It skips the answer when the run answered the
starter's reply-enabled message (board.delivery replies to it), when the run itself called `message` to the starter, and when the answer is empty, failed or aborted. An answer whose last line is a question or a
numbered option asks for a decision and wakes the starter as a follow-up; any other answer is a note, which wakes nothing.
An answer to the starter's one-way message is routed like any other: it gets no reply, and may carry a decision.
This cannot loop: routing goes only from a branch to its starter, which existed before it, and a routed message is
one-way, so the starter's answer to it goes nowhere.
The reply assessment is not used: it arrives later, from the summary model, and only when one is configured. Request id
`route:<answer entry>` deduplicates delivery in the branch's `board.requests`, so a restart never sends an answer twice.
Before sending its first input, the tool rereads the `coordinator` definition (built-in, user, then trusted project override), applies only its instructions, and marks `ultimate.metadata.label = 'coordinator'`. The branch keeps its inherited model and tools. Coordinators report decisions to @ultimate and send it one-way landing or failure updates with the sha and divergence.
The tool gives lineage its task and call ids for a task-scoped receipt, recorded atomically with the fork, so replay cannot
create another branch even before the branch-id memo is saved. Pi retires that receipt when the originating task completes.
It deduplicates message admission with the same task-scoped `board.sent-calls` receipt as `message`, indexed by call id
so nested codemode calls stay distinct.

Ultimate answers the user's typed input directly in its conversation. To relay a branch result, decision or landing
to the user, Ultimate sends one consolidated `message {to: 'user', text}` when the needed replies have arrived.
It appears there as a bubble with an answer card for questions. Decisions use a reply-expected message or the final
answer to the user's input, ending with numbered options; reports that need no answer use `reply: false`.

## Document and typed inputs

`Board` (kind `board`, version 1) is exported on `ROOT_CONVERSATION_ID`:

```ts
{ messages: BoardMessage[]; next: number }
```

`next` starts at 1. The log keeps the newest 300 items; transcripts retain delivered inputs.
Version 1 remains loadable: Pi documents do not validate object fields, so existing logs' unused `readUpTo` field needs no migration.

```ts
type BoardMessage = {
  id: number
  from: number | 'user'
  to: number | 'user'
  text: string
  at: number // Unix milliseconds
  reply: boolean
  re?: number
  state: 'sent' | 'delivered' | 'answered' | 'failed'
  entry?: EntryId
  answer?: EntryId
  error?: string
}
```

`board.message` data: `{ id, from, text, reply, delivery: 'steer' | 'followUp' | 'note', images? }`, where `images` counts the forwarded images in its model content; the card shows them as thumbnails.
`board.reply` data: `{ id, re, from, text, failed }`. A reply has its own id and `re` points to the original message.
The reply's `answer` links to the recipient's assistant entry; the original also stores its input `entry`.

## Actions

- `addresses({}) → { agents, lander?, conversations }`: resident names/descriptions with an id if already created,
  the existing project lander id, and up to 50 recent top-level conversation summaries (including title and label).

Users type in @ultimate's conversation or answer a question card; there is no user posting action.
Agents use the `message` tool. The prompt section is stable and lists resident names and descriptions.

## Service

`host.want(BoardApi)` exposes `send`, a one-way message from a conversation (the lander's deploy
handoff), and `answer`, the user's reply to an open message (the questions answer card). Landings and submissions
append no log items. `BoardApi`, `BoardMessage` and the `Board` document live in `api.ts`.

## UI

There is no Board surface: the board is plumbing, and everything it carries renders in transcripts. You talk to
@ultimate in its own conversation (the title bar's `@ultimate` button and the sidebar's top row, both in
[conversations](../conversations/README.md), open it). Every sender has a stable accent (`accent.tsx`: you the
brand colour, others a small palette by id) shown as a stripe, a faint fill and the sender name. Typed board
messages and replies render as compact transcript cards with Source / Return navigation, in the sender's accent.
Incoming messages show whether they expect a reply or are one-way, plus their delivery mode (steered, follow-up or note) when recorded. Final answers name their reply
destination, or say “not sent” for a one-way message. Answers that cover several board messages list each
destination; unrelated answers show no board label.

@ultimate's own conversation reads as a chat (the `chat` contribution): each run of tool calls and thinking folds into
one “worked · N steps” row, while messages, branch starts, workspace outcomes, onboarding setup cards and answers stay. Its messages to you
are bubbles on the left in its accent, their footer saying awaiting your reply, answered or one-way; an answer card
mounts beneath the text (`ChatBubble` children). Each log message records the tool call that sent it (`call`: the
`message` call's id, or `<script>/<n>` for a nested codemode call), so a message @ultimate sent from a `codemode`
script is a bubble too, bound to that exact message, beneath a quiet “sent with codemode” line that opens the script.
The script shows as soon as the log holds a message it sent, while it runs or after it was interrupted; messages from
before the log recorded calls, or that the bounded log dropped, leave it folded. Once the bounded log has dropped a
direct message, its bubble shows no state. An answer that went back to the branches that asked folds to “replied to
#id”.
