# Questions

Answer cards for @ultimate's questions to the user. One thing asks: a reply-expected
message to the user. @ultimate's `message { to: 'user', text, reply: true }` (the default) makes messages emit
`board.asked` in the transaction that appends the message; questions' `asked` reactor records the request and creates
the extraction task in one transaction, once per message. One-way messages, user posts and messages to conversations
never do. Final answers never ask: @ultimate's instructions put every decision in such a message.

A message ending with a decisions block is read without a model (`lib/decisions.ts`):

```
Decisions:
1. **Topic:** (a) first option; (b) second option.
2. **Topic:** (a) …; (b) ….
My picks: 1a 2b.
```

Only the last run of numbered items with lettered options counts, so numbered findings earlier in the message are
ignored; each becomes a choice with its number as `ref`, its letters as option `key`s, and the picks as `recommended`.
Any other message goes to the configured summary model, which extracts only decisions and options present in the text,
using `QUESTIONS_SYSTEM`; only decisions available now count, not pending work or a future branch proposal. Stated picks
mark options recommended and never count as decided. Rhetorical closers, offers, empty results and model failures
produce no extracted questions. Extraction memoizes its model and response and accounts usage on the root. The
open-questions note names a message by its decision topics when it has a decisions block.

A question stays open until the user answers it (its card, or a Reply to that message) or dismisses it. Typed input,
answers to other messages and agent messages leave it open. While it is open, messages starts each of the asker's runs
with a line listing it (see [Messages](../messages/README.md)).

## State

The root's `questions.board` document (conversation scope, latest history, initial on fork) holds
`requested: number[]` and `asked: Record<string, Question[]>`. The root-owned background task
`questions.board-extract` (input `{ messageId, text }`) deduplicates by message id; `asked[String(messageId)]` is
written only for a nonempty result while the message remains open (`to === 'user'`, `reply`, `state === 'delivered'`).
Both are pruned to ids still in the Messages log when writing. Reopening resumes durable work without repeating a
memoized response or creating duplicate cards.

## Card

Under the outgoing `message` card in @ultimate's transcript, through messages’ `MessageAnswers` point. One question is
open at a time; the others fold to a line with their answer (`1b drop them`) or “not answered”, and a dot per question
shows progress. Kinds: `choice` (one option), `multi` (any), `confirm` (Yes/No), `scale` (numbered steps with end
labels) and `text` (a field); options offer “Something else…” with an inline field, and an option's Markdown `preview`
shows beside the options for the hovered or chosen one. Recommended options carry a “my pick” chip. **Accept picks**
chooses every pick still open; Send sends what is answered (“Send 2 of 5”). Sending opens a 3 s window with Undo before
the answer goes out, then the card settles into the summary of what was sent. Dismiss closes the message without an
answer. A message without extracted questions gets a one-line answer field (sent as a Reply to that message) and
Dismiss. On desktop, 1–9 or an option's letter (`y`/`n` for Yes/No, `o` for Something else) chooses, ↑/↓ moves
between questions, Enter takes the open question's pick or goes to the next, and sends from the last one; ⇧Enter
accepts every pick and sends; Esc clears an answer or, while sending, undoes. Only the shown conversation's newest open
card takes these keys; they leave alone input/textarea editing and keys pressed in another card, on another control or
in the panel, whose cards take no global keys. The Questions playground surface shows every kind with sample data.

## Where open questions wait

The To-dos tab lists every message that waits on the user at its top, newest first; a row opens the asking
conversation at the message, where this card answers or dismisses it. The amber count next to the top-bar @ultimate
button opens the tab from any surface; ⌘K “Show open questions” does too.

## Actions

Both are user-only.

- `answer { messageId, answers: [{ question, answer }] }` validates the extracted questions, refusing unknown or
  duplicate answers, and posts a normal user reply to the sender with `re: messageId`, one paragraph per answer in the
  message's own numbering: `1a. Topic: option` for an option, `2: text` for typed text (`Topic: answer` when the
  message numbered nothing), returning `{ id }`. `answer { messageId, text }` posts `text` instead, for a message with or without extracted
  questions. Messages admission atomically verifies that the original remains open, so concurrent answers produce
  exactly one reply; normal Messages delivery wakes the sender.
- `dismiss { messageId }` marks the message `dismissed` and posts a one-way user note to the sender with `re`, in one
  commit, returning `{ id }`. The note reaches the sender as a note: it reads it with its next input, and no run
  starts. A message that is no longer open is refused.

Retired transcript question and answer entries are hidden rather than exposing their raw JSON.
