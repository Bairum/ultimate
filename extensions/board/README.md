# Board

Durable messages between conversations, standing agents and the user. Built in and on by default.

## Messaging

`message { to, text, reply?: true, steer?: false }` returns the message id immediately. Address a conversation
as `#123` or `123`, a standing agent as `@name`, the project's existing lander as `@lander`, or the inbox as `user`.
Self-messages, unknown conversations and tallies are refused; use `note` for a tally. Unknown standing names list
the valid ones. Standing agents are resolved and configured through the `subagents` service at delivery admission.

An idle recipient wakes. A busy one receives a follow-up after its current run, or steering during that run with
`steer: true`. The typed `board.message` input identifies its sender and explains where its answer goes.
The answer returns as `board.reply`, steering the sender. An unanswered input produces a failure reply instead.
`reply: false` is one-way: it wakes the recipient without returning an answer. Sending to `user` only writes an
unread inbox item; it starts no run. Replies to a user post also stay in the inbox without starting a run.

The message tool is replay-safe: it memoizes the sent id. A task-scoped `board.sent` receipt commits with the
message and delivery task, preventing a duplicate even if interrupted before the memo is saved.
Delivery is a background durable task owned by the root conversation. Stable request ids (`board:<id>` and
`board-reply:<reply-id>`) deduplicate submissions across reopen. Recording the answer, appending its reply and
advancing the task checkpoint happen in one transaction. A reopened task resumes that checkpoint, so both a
placed input awaiting an answer and a recorded answer awaiting delivery survive without duplicate replies.

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

`board.message` data: `{ id, from, text, reply }`.
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

The Board surface shows all traffic oldest first, or just your Inbox. Opening Inbox marks its messages read;
a quiet `inbox N` status-line button appears on every surface while messages are unread. Cards show addresses,
time, delivery state, reply quotes and an Open link when the transcript entry is known. Landing items use a merge icon.

Start a post with `@agent` or `#conversation`; autocomplete lists resident agents, the lander and recent conversations.
Without an address, posts go to `@ultimate` when it exists. Enter sends on desktop (Shift+Enter inserts a newline);
on touch keyboards, return always inserts a newline and the arrow button sends. Reply retains a link to its original
message. Typed board messages and replies render as compact transcript cards with Source / Return navigation.
