Shrinks model requests by replacing redundant tool-result text, without changing stored history.

Enable `context-hygiene` with `extensions.enable`. Successful covering reads supersede older reads of the same resolved path. Coverage uses returned text and Pi's `details.truncation` metadata (which survives in request messages), not the requested limit: truncated reads are never whole, and unknown coverage is not superseded. Partial reads do not supersede across any intervening tool except `read` or `grep`; untruncated whole reads show the current file and can supersede across mutations. Tools opt into empty-result elision with `details.useless: true`. Exact duplicates (tool name, canonical arguments and text) elide the older result. Errors and images are always protected. The newest 16k estimated tokens are protected only from pressure-driven elision; cold-cache, new-context and cheap-suffix gates can apply recent redundancy decisions. Estimates use Pi's exported `estimateMessageTokens` and `estimateTextTokens` helpers; request messages retain tool-result details in this Pi version.

Decisions are discovered on the first `beforeRequest` seeing eligible results. The rewindable, fork-`asOf` ledger records pending/applied decisions. Applied decisions always rewrite subsequent requests. Pending decisions apply only on a cold cache, a new context, a cheap suffix or context pressure. The ledger commits before rewriting, including on retries. Failures leave the request unchanged and publish a diagnostic. Stored entries, search and compaction inputs retain full text.

New context detection uses the context head entry: no assistant entry newer than the compaction/reset marker means this is its first request. Retained older assistants do not prevent this gate. A request with no assistant messages is also new. Pending decisions absent from a request are ignored. On requests with a compaction head, decisions absent from the remaining request are pruned because compaction removes a prefix. Applied decisions still present remain monotonic. Empty or non-unique call/result ids are excluded from detection; rewrites require a nonempty id identifying exactly one result. The ledger checkpoints after 64 deltas.

On Anthropic models (`anthropic-messages`, and `claude-code-stream-json` through Claude Code) the cheap-suffix gate also requires at most 14 content positions through the issuing assistant, reserving six of Anthropic's 20-position cache lookback for the next input. Consecutive tool-use blocks count once, consecutive tool-result blocks once, and other nonempty blocks individually. Other model APIs skip this bound; cold-cache, new-context and pressure gates are unchanged.

Masking is off by default; turn it on with `"contextHygiene": { "mask": true }`. A replay over this project's stored history priced it as a small net cost at Claude's cache-read rate (the one-time rewrite outweighs the cheaper resends), so it pays only for context headroom: later compaction. When on, under pressure, old text-only non-error results of at least `maskMinTokens` are masked if their combined estimated savings reach `pressureSavings`. The newest `maskProtectTokens` are untouched. Masking requires the optional `context-offload` store: full text is saved before committing an applied `masked` decision, whose placeholder records the stable recovery path. Missing storage or save failures keep the result and publish a notice. `details.offloadExempt` results (including hashline's bounded reads) can still be masked, since the saved file permits recovery. A file offload already saved is kept, not overwritten. Masks apply only under pressure, never from the cold/new/cheap gates.

Settings under `contextHygiene` in machine/project `.ultimate/settings.json` (trusted project settings override machine settings per key, via `host.projectSettings()`):

| Key                 | Default |
| ------------------- | ------- |
| `cacheTtlMs`        | 3600000 |
| `protectTokens`     | 16000   |
| `suffixTokens`      | 8000    |
| `suffixSavings`     | 2000    |
| `pressureRatio`     | 0.6     |
| `pressureSavings`   | 8000    |
| `maskProtectTokens` | 40000   |
| `maskMinTokens`     | 500     |

Values must be finite nonnegative numbers. Pressure uses the selected model's context window. Stats count estimated applied savings and requests that apply new decisions, not every rewritten request or retry. They are not provider-measured savings or cache usage.

Tool cards for read/bash/grep/edit receive a muted elision tag beneath their existing renderer. The renderer registry has no wildcard contribution; other tools still receive request hygiene without the tag.

Relative paths are resolved against the conversation's current cwd. Residual risk: if that conversation changed cwd between earlier reads, the old relative arguments may resolve differently; cwd history is not reconstructed here. Absolute paths avoid this ambiguity.

Deliberate design deviations: pressure is measured against the model's context window rather than a separate compaction threshold; there is no “no caching” gate and no per-request provider cache metrics yet. Decisions are discovered in `beforeRequest`, not `afterTools`.

`api.ts` exports the ledger and `ContextHygiene` service contract; consumers use `host.need(ContextHygiene)` for `gateOpen` and `rewrite`. Pure implementations live in `rewrite.ts`, in keeping with the repository's contract-only API convention.

Credits: inspired by oh-my-pi's superseded/useless pruning and `cacheLookbackFloor` (MIT, `packages/agent/src/compaction/pruning.ts`), https://github.com/can1357/oh-my-pi. Independently implemented; no code copied.

Tests: `pnpm vitest run test/context-hygiene*.test.ts test/extension-enablement.test.ts` runs the fast faux-provider and enablement checks.
