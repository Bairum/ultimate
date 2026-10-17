# Questions

Optional answer cards for reply-expected Board messages to the user. Only an agent's `message { to: 'user',
text, reply: true }` (the default) triggers extraction, in the same transaction that appends the message.
One-way messages, user posts, messages to conversations, and transcript reply assessments never trigger it.
The configured summary model extracts only decisions and options present in the message; rhetorical closers,
offers, empty results and model failures produce no card.

Extraction is a root-conversation-owned durable background task, `questions.board-extract`, with input
`{ messageId, text }`. It memoizes the model and response and accounts usage on the root. The root's
`questions.board` document (conversation scope, latest history, initial on fork) contains
`{ requested: number[], asked: Record<string, Question[]> }`. Requests deduplicate by Board message id;
`asked[String(messageId)]` is written only for a nonempty result while the message remains open
(`to === 'user'`, `reply`, `state === 'delivered'`). Both collections are pruned to ids still in the Board log
when writing. Reopening resumes durable work without repeating a memoized response or creating duplicate cards.

The card renders inside the open message's bubble. Confirmations offer Yes/No; choices show the extracted
options and their recommended marker. Both offer “Something else…” with an inline field. Send answers is
enabled after at least one answer; omitted questions stay out. On phones, one question shows at a time with
Back/Next. On desktop, 1–9 and Enter act on the newest open card, without intercepting input/textarea editing.
The card disappears once a card answer, a Reply, a new post to the sender, or typing in the sender's
conversation answers the message.

The user-only `answer` action accepts `{ messageId, answers: [{ question, answer }] }` without a conversation id.
It validates the extracted questions and refuses stale, unknown or duplicate answers. It posts a normal user
Board reply to the sender with `re: messageId`, formatting answers as `Q: …\nA: …` blocks separated by blank
lines, and returns `{ id }` for that reply. Board admission atomically verifies that the original remains open,
so concurrent answers produce exactly one reply. Normal Board delivery wakes the sender with the Q/A text.

Stored transcript `questions.asked` entries are hidden and never answerable. Stored `questions.answers`
entries retain their read-only “Your answers” card; new answers go through the Board instead.

On a faux instance, send `questions demo`: the faux agent messages the user with a confirmation and a
recommended choice, then says `Sent.`. Extraction uses the faux model by default (explicit summary-model
settings still win), and the Board answer gets the scripted Q/A follow-up without tokens.
