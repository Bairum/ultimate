# Questions

Answer cards and the Questions panel for @ultimate's questions to the user. One thing asks: a reply-expected Board
message to the user. @ultimate's `message { to: 'user', text, reply: true }` (the default) makes board emit
`board.asked` in the transaction that appends the message; questions' `asked` reactor records the request and creates
the extraction task in one transaction, once per message. One-way messages, user posts and messages to conversations
never do. Final answers never ask: @ultimate's instructions put every decision in such a message.

The configured summary model extracts only decisions and options present in the text, using `QUESTIONS_SYSTEM`;
only decisions available now count, not pending work or a future branch proposal. Rhetorical closers, offers, empty
results and model failures produce no extracted questions. Extraction memoizes its model and response and accounts
usage on the root.

A question stays open until the user answers it (its card, or a Reply to that message) or dismisses it. Typed input,
answers to other messages and agent messages leave it open. While it is open, board starts each of the asker's runs
with a line listing it (see [Board](../board/README.md)).

## State

The root's `questions.board` document (conversation scope, latest history, initial on fork) holds
`requested: number[]` and `asked: Record<string, Question[]>`. The root-owned background task
`questions.board-extract` (input `{ messageId, text }`) deduplicates by Board message id; `asked[String(messageId)]` is
written only for a nonempty result while the message remains open (`to === 'user'`, `reply`, `state === 'delivered'`).
Both are pruned to ids still in the Board log when writing. Reopening resumes durable work without repeating a
memoized response or creating duplicate cards.

## Card

Under the outgoing `message` card in @ultimate's transcript, through board's `MessageAnswers` point, and in the
Questions panel. Confirmations offer Yes/No; choices show the extracted options and their recommended marker. Both
offer “Something else…” with an inline field. Send answers is enabled after at least one answer; omitted questions stay
out. Dismiss closes the message without an answer. A message without extracted questions shows only Dismiss and a
hint to reply in the composer. On phones, one question shows at a time with Back/Next. On desktop, 1–9 and Enter act
on the shown conversation's newest open card, without intercepting input/textarea editing; cards in the panel take no
keys.

## Questions panel

A right-panel tab listing every message that waits on the user, newest first: the asker, how long ago, the message,
its card and Dismiss, and a Show in chat link. It lists only what is open, so a question leaves it once answered or
dismissed. The amber count next to the top-bar @ultimate button opens it from any surface; ⌘K “Show open questions”
does too.

## Actions

Both are user-only.

- `answer { messageId, answers: [{ question, answer }] }` validates the extracted questions, refusing unknown or
  duplicate answers, and posts a normal user Board reply to the sender with `re: messageId` and `Q: …\nA: …` blocks,
  returning `{ id }`. Board admission atomically verifies that the original remains open, so concurrent answers produce
  exactly one reply; normal Board delivery wakes the sender.
- `dismiss { messageId }` marks the message `dismissed` and posts a one-way user note to the sender with `re`, in one
  commit, returning `{ id }`. The note reaches the sender as a note: it reads it with its next input, and no run
  starts. A message that is no longer open is refused.

Retired transcript question and answer entries are hidden rather than exposing their raw JSON.

## Faux

On a faux instance, open @ultimate (Agents tab → ultimate) and type `questions demo`: @ultimate messages the user with
a confirmation and a recommended choice, then says `Sent.`; the card appears under the message and in the panel.
Extraction uses the faux model by default (explicit summary-model settings still win), and an answer gets the scripted
reply without tokens.
