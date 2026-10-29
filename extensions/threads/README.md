Feature threads in @ultimate's conversation: each entry belongs to the branch it is about, so the transcript can be read one feature at a time.

## Bucketing (`threads.tsx`)

`threadsOf(entries, messages, self)` is plain code over what the transcript and the message log already record; no model
decides it and @ultimate does nothing differently.

- A branch's messages and replies, its landing report and its notes belong to that branch, by their sender.
- The user's answer to a question belongs where the question came from: the call that asked it.
- A turn belongs to the inputs that woke it (a run of inputs with no response between them wakes one turn).
- A call that starts a branch, or messages one (itself or in a script), belongs to that branch; the turn's other calls
  and its answer belong to the turn. A turn nothing threaded woke takes the branches its calls address.
- A tool result belongs with its call.

Unplaced, by design: the user's own prompts, build and to-do notes, notes about main, memory recalls, automation
fires and messages from other projects. A turn woken by several branches at once belongs to each of them.

## UI (`web.tsx`)

- **Thread bar** above @ultimate's composer: All, then a chip per thread (live ones first, then the latest landed),
  each with its feature tag and where it stands. A chip focuses the transcript on that thread (`useThreadFocus`,
  durable UI state): its rows show whole, other threads fold into the between lines, the user's own prompts stay.
- **Lanes** (the toggle at the bar's end, `useThreadLanes`): one coloured column per thread beside the rows, a dot on
  each of its rows, ending where it landed. Colours follow the feature tag's hue.
- **Catch-up**: under a landing card in @ultimate, the branch's abstract frozen at landing (lineage's `abstract`
  action), so the reader gets where the feature ended without opening the branch.

The core transcript does the folding: this extension contributes `compact.threads` (the bucketing) and `compact.lane`.
