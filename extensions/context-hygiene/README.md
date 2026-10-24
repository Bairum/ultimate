Shrinks model requests by replacing redundant tool-result text, without changing stored history.

Enable `context-hygiene` with `extensions.enable`. Successful covering reads supersede older reads of the same resolved path; partial reads do not supersede across an intervening edit/write. Tools opt into empty-result elision with `details.useless: true`. Exact duplicates (tool name, canonical arguments and text) elide the older result. Errors and images are always protected. The newest 16k estimated tokens are protected only from pressure-driven elision; cold-cache, new-context and cheap-suffix gates can apply recent redundancy decisions. Estimates use Pi's exported `estimateMessageTokens` and `estimateTextTokens` helpers; request messages retain tool-result details in this Pi version.

Decisions are discovered on the first `beforeRequest` seeing eligible results. The rewindable, fork-`asOf` ledger records pending/applied decisions. Applied decisions always rewrite subsequent requests. Pending decisions apply only on a cold cache, a new context, a cheap suffix or context pressure. The ledger commits before rewriting, including on retries. Failures leave the request unchanged and publish a diagnostic. Stored entries, search and compaction inputs retain full text.

New context detection uses the context head entry: no assistant entry newer than the compaction/reset marker means this is its first request. Retained older assistants do not prevent this gate. A request with no assistant messages is also new. Pending decisions absent from a request are ignored; applied ledger records remain monotonic even after compaction.

Settings under `contextHygiene` in machine/project `.ultimate/settings.json` (project overrides machine):

| Key               | Default |
| ----------------- | ------- |
| `cacheTtlMs`      | 300000  |
| `protectTokens`   | 16000   |
| `suffixTokens`    | 8000    |
| `suffixSavings`   | 2000    |
| `pressureRatio`   | 0.6     |
| `pressureSavings` | 8000    |

Values must be finite nonnegative numbers. Pressure uses the selected model's context window. Stats count estimated applied savings and requests rewritten, including attempts. They are not provider-measured savings or cache usage.

Tool cards for read/bash/grep/edit receive a muted elision tag beneath their existing renderer. The renderer registry has no wildcard contribution; other tools still receive request hygiene without the tag.

`api.ts` exports the ledger and `ContextHygiene` service contract; consumers use `host.need(ContextHygiene)` for `gateOpen` and `rewrite`. Pure implementations live in `rewrite.ts`, in keeping with the repository's contract-only API convention.

Credits: inspired by oh-my-pi's superseded/useless pruning (MIT), https://github.com/can1357/oh-my-pi. No code copied.

Tests: `pnpm vitest run test/context-hygiene*.test.ts test/extension-enablement.test.ts` runs the fast faux-provider and enablement checks.
