Feature threads in @ultimate's conversation: each feature's traffic goes into its own thread, and the main stream keeps one root row per feature.

## Bucketing (`threads.tsx`)

`threadsOf(entries, messages, self)` is plain code over what the transcript and the message log already record; no model
decides it and @ultimate does nothing differently.

- A branch's messages and replies, its landing report and its notes belong to that branch, by their sender.
- The user's answer to a question belongs where the question came from: the call that asked it.
- A reply typed in a thread starts with `Re #<branch>: `; it and the turn it wakes belong to that thread.
- A turn belongs to the inputs that woke it (a run of inputs with no response between them wakes one turn).
- A call that starts a branch, or messages one (itself or in a script), belongs to that branch; the turn's other calls
  and its answer belong to the turn. A turn nothing threaded woke takes the branches its calls address.
- A tool result belongs with its call.

Unplaced, by design: the user's own prompts, build and to-do notes, notes about main, memory recalls, automation
fires and messages from other projects. A turn woken by several branches at once belongs to each of them.

`threading(entries, threads)` decides the main stream: the turn a thread began in stays, its root row follows that turn's
answer, and every later entry of exactly one thread leaves the stream for that thread.

## UI (`web.tsx`)

- **Root row** (`threads.root`): the feature, where it stands (working, waiting on you, landed), the newest reply's first
  line, the reply count and when it last moved, with an unread dot. A click opens the thread.
- **Thread pane** beside the conversation (`conversation.overlay`): the thread's entries (the core's `ThreadView`,
  cards open) and a composer whose words go to @ultimate as `Re #<branch>: …`.
- **Catch-up**: under a landing card, the branch's abstract frozen at landing (lineage's `abstract` action).

The core transcript does the splitting: this extension contributes `compact.threads`.
