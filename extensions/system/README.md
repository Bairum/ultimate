One stream of everything Ultimate records: durable events (`host.eventLog`) and the call trace (`host.trace`: service, action, reactor, tool and model calls), merged into one row shape, paged and filtered on the server. The System surface reads it; agents can call it with `ultimate.action('system', 'stream', …)`. Optional; it changes nothing.

Actions (contracts in `refs.ts`):

- `stream { before?, after?, limit?, sources?, kinds?, conversation?, errors?, text? }` → `{ rows, next?, head }`. Rows newest first, at most `limit` (default 200, at most 500). Each row is `{ id, source, at, kind, name, conversation?, trace?, ok, ms?, error?, summary }`: an event has kind `event`, id `e<event id>` and its data as summary; a call has its kind, its id and `caller → callee  args` as summary (arguments as the trace stored them, secrets redacted and tool arguments sealed).
  - Order: events by when they were emitted, calls by when they finished (the trace writes a call when it settles), ties by id.
  - `before: next` pages back; `next` is absent once nothing older matches. `after: head` follows live: the rows recorded since the cursor, newest first, the oldest `limit` of them when more arrived, with a new `head`. Cursors are opaque (`<event id>.<trace position>`), one position per source, so paging never skips or repeats a row; reuse them only with the same filters.
  - Filters: `sources` (`event`, `call`), `kinds` (event names and call kinds together: `['workspaces.landed', 'tool']`), `conversation` (the event's emitting conversation or the call's), `errors` (failed calls only, so no events), `text` (case-insensitive substring of name, caller, callee, arguments, error or event data). Call filters run in SQL on `trace.sqlite`; event filters run while scanning the event log.
- `lanes { since?, until? }` → `{ now, lanes, more? }`: who worked when, for the Agent Lanes timeline. Default window: the last 30 minutes. One lane per conversation with tool or model calls in the window (trace kinds `tool` and `model`), most recently active first, at most 40 (`more` counts the rest). A lane's runs are its calls grouped into stretches split by more than 20 s of quiet, each `{ start, end?, ok, calls, more? }` with at most 200 calls (`{ at, ms, kind, name, ok, trace }`) (`more` counts the newer ones left out). The last run has no `end` while it is open: its last call ended under 20 s ago or the conversation has a live foreground task (the harness task graph); a window ending in the past is never open. `agent`, `model`, `kind` and `parent` come from the conversation's newest `subagents.started` event when there is one; titles are the browser's to resolve.
- `tree { trace }` → `{ calls, events }`: the call tree of one trace, as `stream` rows with `parent` and `children`, and the events emitted in that trace, oldest first.

The **System** surface (⌘K "Open System", or "System ↗" in the Activity panel) shows both. **Agent Lanes** on top:
one row per lane with its agent's mark, model and state (running, needs you, idle) and its runs as blocks on a
30 m / 2 h / 24 h timeline, labelled by their main tool, with calls as ticks (failed ones red). A block opens its calls
and a call its trace tree; a lane's name opens the conversation, its filter button narrows the stream to it. Below,
**All events**: the stream with source chips, errors only, a conversation filter and text, each row opening its trace
tree, older pages loading at the end. Both poll every 2 s while the surface is on screen. Under faux, the `seedLanes`
action of `faux` writes demo lanes.

Uses two read methods of the core: `host.trace.page()` (calls by write position with the filters above and a `since`/`until` start-time window) and `host.eventLog.recent({ before, order })`.
