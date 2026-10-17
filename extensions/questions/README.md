# Questions

Optional answer cards for @ultimate's questions to the user, in its own transcript. Two things ask:

- **A reply-expected Board message to the user.** Any agent's `message { to: 'user', text, reply: true }` (the
  default) triggers extraction in the same transaction that appends the message. One-way messages, user posts and
  messages to conversations never do. The card shows under the outgoing `message` tool card in the sender's
  transcript.
- **@ultimate's final answer to a typed input.** Only in the standing `ultimate` conversation (the `Standing` index
  of `subagents`), and only when the answer settles a plain `pi.user` input: answers to Board messages, Board
  replies, and every other conversation's answers never trigger it. The card shows under that final answer.

The configured summary model extracts only decisions and options present in the text, using `QUESTIONS_SYSTEM`;
rhetorical closers, offers, empty results and model failures produce no card. Extraction memoizes its model and
response and accounts usage on the task's conversation.

## State

The root's `questions.board` document (conversation scope, latest history, initial on fork) contains:

- `requested: number[]` and `asked: Record<string, Question[]>` for Board messages. The root-owned background task
  `questions.board-extract` (input `{ messageId, text }`) deduplicates by Board message id; `asked[String(messageId)]`
  is written only for a nonempty result while the message remains open (`to === 'user'`, `reply`,
  `state === 'delivered'`). Both are pruned to ids still in the Board log when writing.
- `yielded` and `reply?: { conversation, entry, questions }` for @ultimate's answers. A `GenerationTask` `onYield`
  hook creates one `questions.reply-extract` task per generation, owned by @ultimate's conversation, in the commit
  that advances `yielded`, so a replayed hook creates nothing twice. The task waits for the generation, confirms its
  answer settled a `pi.user` input, extracts, and writes only if that answer is still current (`currentAnswer`: no
  later input, queued input, run or reset): questions replace `reply`, an empty result clears it. One slot is enough
  because only @ultimate's latest answer can be answered; it cannot grow.

Reopening resumes durable work without repeating a memoized response or creating duplicate cards.

## Card

Confirmations offer Yes/No; choices show the extracted options and their recommended marker. Both offer “Something
else…” with an inline field. Send answers is enabled after at least one answer; omitted questions stay out. On
phones, one question shows at a time with Back/Next. On desktop, 1–9 and Enter act on the newest card of the shown
conversation (its final-answer card, else its newest open message card), without intercepting input/textarea
editing.

A message card disappears once its message is answered: by the card, a Board Reply or new post to the sender, or
typing in the sender's conversation. A final-answer card disappears as soon as any input or reset follows the answer,
or once its answer is claimed.

## Actions

Both are user-only and validate the extracted questions, refusing unknown or duplicate answers. Answers are
formatted as `Q: …\nA: …` blocks separated by blank lines.

- `answer { messageId, answers: [{ question, answer }] }` posts a normal user Board reply to the sender with
  `re: messageId` and returns `{ id }`. Board admission atomically verifies that the original remains open, so
  concurrent answers produce exactly one reply; normal Board delivery wakes the sender.
- `reply { entryId, answers }` refuses unless `entryId` is @ultimate's current answer (`currentAnswer`: no later
  input, queued input, run or reset) and claims the card by clearing `reply` in the same commit, so of concurrent
  calls exactly one wins and the rest are refused. It then submits a plain input in @ultimate's conversation with
  `requestId: questions:<entryId>` and `whenBusy: 'reject'`; if the submit fails, a compensating commit restores the
  claim when no newer `reply` replaced it, so the user can retry. Without an input-placement hook, an input or reset
  can still land between the claim and the submit; we accept that window of milliseconds because the Q/A text is
  self-contained and the user's own words.

Stored transcript `questions.asked` entries from older builds are hidden and never answerable. Stored
`questions.answers` entries retain their read-only “Your answers” card.

## Faux

On a faux instance, open @ultimate (Agents tab → ultimate) and type:

- `questions demo`: @ultimate messages the user with a confirmation and a recommended choice, then says `Sent.`;
  the card appears under the message.
- `ask demo`: @ultimate's final answer is the same two decisions; the card appears under the answer.

Extraction uses the faux model by default (explicit summary-model settings still win), and an answer gets the
scripted reply without tokens.
