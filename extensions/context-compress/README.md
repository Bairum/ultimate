# Context compression

Lets an agent reversibly fold finished old turns into its own summary, reducing model requests without changing stored history.

## Enable

Default-off. Enable both this extension and its required context-hygiene service in machine or project settings:

```json
{ "extensions": { "enable": ["context-hygiene", "context-compress"] } }
```

There are no additional settings. The newest 16,000 estimated tokens are protected (including the whole turn crossing that boundary). The unfinished last turn is never offered. Estimates use Pi's token estimators, not provider billing counts.

## Tools

- `context_ranges {}` lists eligible turns: id of the user input entry, entry span, estimated tokens, first input line and tool names, and active compression id if any. It also lists active ranges.
- `compress { from, to, summary }` selects inclusive turn ids from that list. Only contiguous whole turns outside the protect window qualify. Active ranges cannot overlap. The agent writes a non-empty summary no larger than 25% of the selected estimated tokens. Compression begins on the next request.
- `decompress { id }` makes the range inactive, restoring its original messages on the next request (subject to context-hygiene's independent tool-result elisions).

The fixed prompt recommends compressing finished sub-tasks and preferring a few large ranges. Cards show eligible turns, compression summaries and estimated savings, or restoration ids. The transcript itself remains complete and unchanged.

## Data and safety

`context-compress.ranges` is a conversation-scoped, rewindable document, forked as of the fork point and checkpointed every 64 deltas. Pi Durable requires document roots to be objects, so its data is `{ ranges: [{ id, fromEntry, toEntry, summary, tokens, active, at }] }`. `tokens` is the original estimated size, `at` the recording time. Compression ids derive from the durable tool task id so replays do not create duplicates.

Identity is stored entry ids, never timestamps or tool-call ids. Contributions align request messages back to entries, accommodating reordered results and context-hygiene's applied rewrites. Other hooks' injected messages and system messages remain untouched. Each active range replaces its original messages with one deterministic user message:

```xml
<compressed id="c3" turns="12–28">The agent's summary.</compressed>
```

Call/result pairing is checked before applying the fold. An inconsistent mapping, split pair, failed read or failed commit leaves the incoming request untouched and emits a notice explaining why. Ranges whose endpoints have left the active context after compaction become inactive; compaction itself is not reversible through decompress. Stored entries are never edited or deleted by these tools.

## Limitations and follow-up

A summary can lose useful detail: decompress or consult stored history when needed. Compression intentionally breaks the cached prefix; it does not use hygiene's cache-timing gate. Unrecognized message transformations from other hooks fail open instead of guessing ownership. Token savings shown on the card exclude wrapper overhead and are estimates. Reusing summaries in `beforeCompact` is a follow-up, not implemented here.

## Credit

Model-called compress/decompress is inspired by [billion-context](https://github.com/ranxianglei/billion-context) (MIT). No code was copied.
