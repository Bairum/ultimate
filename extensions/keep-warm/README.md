Keeps @ultimate's and waiting coordinators' Claude prompt caches warm across idle gaps. On by default; the existing `warm` status-line chip lists each cache and turns warming off.

## Why

Most expensive full cache rewrites followed idle gaps while a coordinator waited on delegated work. Both `claude-code` and direct `anthropic` requests now use the one-hour cache. Reading a cache costs a tenth of the input price; writing a one-hour cache costs twice the input price. A small ping can preserve the existing prefix rather than rebuild it after a break.

## Targets and bounds

- @ultimate comes from the root `Standing` document. Coordinators come from `Profile.definition`, or the agent's metadata label for branches (the same definition lookup used by `fast`). No workers, reviewers, scouts or other definitions qualify.
- A coordinator must have no `LiveDoc.run` and either a direct child in its `Subagents.agents` with a live run, or a submission in the workspaces root index's `queue` (both queued and landing submissions remain there until completion). @ultimate only needs to be idle.
- Only `claude-code` and `anthropic` qualify. Once a minute, the timer checks for a cache renewed 55–60 minutes ago by an answer with cache usage on the current provider/model, or a successful ping with cache usage.
- One attempt per conversation per cache window: only 55–60 minutes after the latest real request or cache-reading ping. A waiting coordinator can therefore renew every ~55 minutes, bounded by the failure and 8-hour stops. Attempts also impose a 55-minute floor across model switches.
- Pings stop after 8 hours without user input to @ultimate, for every target. No input since installation means no pings. `user.input` includes typed input and answers to questions.
- No ping when the cached context is under 50k tokens (input plus cache tokens of the request that last renewed it): a miss there costs about as much as the ping.
- Pause (including a rate-limit pause) stops pings. A failure blocks that conversation until a newer real cache request. Cold caches are never rebuilt by a ping.
- The transaction claiming the attempt rechecks the switch, idle state, cache-window spacing and coordinator's pending work. It records `interrupted` before sending, so a crash counts as failure. The result and usage are committed together on the pinged conversation with `accountResponse`.

## Request prefix

The ping sends committed `conversation.context()` messages, applies only the hygiene ledger's `state === 'applied'` decisions through the optional `ContextHygiene.rewrite` service, and ensures the conversations identity line is present once. It appends one user line asking for `ok`. Nothing is added to the transcript. Both providers receive `cacheRetention: 'long'`; neither receives a sessionId, preserving Claude Code's one-shot process behaviour.

The `beforeRequest` audit found:

- `conversations`: identity line, reproduced.
- `context-hygiene`: applied rewrites, reproduced (including masking through the service). A real request may newly apply pending decisions; pings do not make those decisions.
- `fast`: OpenAI session flags only; no message changes.
- `phase`: run bookkeeping only; no message changes.
- `recall`: @ultimate can classify and append new memories for an unprocessed input. Already committed recalls are in the context; a new classification cannot be reproduced without running recall. Pings do not classify.

System-prompt or tool changes, new pending hygiene decisions, and new recalls can still change the next real request. Pings preserve the committed prefix, not future changes.

## State and UI

`keep-warm.state` on conversation 1 is `{ off?, inputAt?, pings?, conversations?: { [id]: Ping } }`. Each `Ping` contains `{ at, provider, model, read?, write?, error? }`. A pre-existing `last` field is ignored; no migration is needed.

- `state` returns `{ on, inputAt?, pings, conversations }`, each conversation with its id, title (or `#id`), latest cache request, next ping when eligible, and last result.
- `set { on }` is user-only: pings spend the user's plan or API balance.
- The quiet `warm` chip stays amber while any listed cache is warm, dimmed while off, red after a failed ping. Its existing popover primitives show each conversation's warm-until/cold-since time, next ping and last result.
