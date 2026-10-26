History keeps a local full-text index of every stored entry, so agents can ask "which conversation decided X?" and get bm25-ranked entries across all conversations, roots' tally entries included. It adds no tools, prompt or UI; agents reach it through `ultimate.search(text, { ranked: true })` in codemode. Nothing leaves the machine.

## Index

The index is `history.sqlite` beside the open chapter's `state.sqlite` (`<home>/history.sqlite` for the first
chapter), an FTS5 table (`porter unicode61` tokenizer) plus each conversation's last indexed entry. It reads entries
through the harness, never the store's file. When the harness opens, a background build indexes what is new, a page
of 100 entries per transaction, yielding between pages; each search first indexes the entries written since. Each entry
is indexed once, under the conversation that wrote it: a fork's scan starts after its fork point.

An entry contributes its messages' text, its tool calls' names with their arguments (the first 1 KB) and its tool
results' text; an entry without messages (a tally abstract, a summary, a card) contributes the strings in its data.
Thinking, images, system prompts (`pi.system`) and durable events (`event.*`, which repeat their own entries) are left
out, and each entry is capped at 16 KB of UTF-8. On this project's host (about 24,500 entries, a 240 MB store) the first build
took 4.4 s and indexed 22,095 entries of 118 conversations into 47 MB.

Each chapter has its own index, so ranked search covers the open chapter only: asking it for a closed `chapter`
throws, and the substring search still reads those.

## Service contract

Import `HistoryApi` from `api.ts` and call `host.want(HistoryApi)` at call time; a disabled history returns
`undefined`. `search(query, { limit?, conversationId? }, context)` returns at most `limit` (default 20, at most 100)
`{ conversation, entry, kind, score, snippet }`, best first: `score` is FTS5's `bm25()` negated (higher is more
relevant) and `snippet` marks the matched terms with `**`. Every word of `query` must match, stemmed and
case-insensitive; `"a phrase"` matches its words in order. Words are quoted before they reach FTS5, so its syntax in
`query` (`OR`, `NEAR(`, `*`, `-`, an unclosed quote) is searched for, never parsed. `conversationId` limits the search to
that conversation's fork-aware history: its own entries and its fork ancestors' up to the fork point.

## Actions

- `stats` (no arguments) → `{ entries, conversations, bytes }`: the indexed entries, the conversations they belong to,
  and the index's size on disk with its WAL. `await ultimate.action('history', 'stats')`.
