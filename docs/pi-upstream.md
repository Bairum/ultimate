## Borrowed from Pi

- `server/http.ts` — adapted HTTP dispatcher, not exported; prevents early provider stream termination. undici in package.json exists only for this file. Drop when Pi exports configureHttpDispatcher and applyHttpProxySettings; keep the MIT notice until then.
- `pnpm-workspace.yaml` — registers patches/@earendil-works__chord@1.3.0.patch, patching sanitizeOutput to remove whole CSI/OSC/control strings while keeping numeric SGR, patches/@earendil-works__pi-durable@1.3.0.patch, adding transactional input-placement hooks, marking entries placed from input submissions (input: true) so extensions can distinguish requests from user-role writes, and recording the requested thinkingLevel on each response as pi-agent-core does, and patches/@earendil-works__pi-claude-code@0.1.0.patch, rebuilding replay cache markers to stay within Claude's four-block limit. Drop each patch when upstream ships the corresponding fix; pnpm errors when a versioned patch no longer matches.
- `test/claude-code-cache.test.ts` — internal imports exercise the pi-claude-code replay cache patch registered in pnpm-workspace.yaml. Drop this coupling and the patch when upstream rebuilds cache breakpoints within Claude's four-block limit.
- `extensions/lineage/server.ts` — inlines Pi's unexported createCompaction so tally checks and manual compaction creation share one transaction. Drop when Pi exposes atomic compaction admission.
- `extensions/lineage/catchup.ts` — uses the patched transactional beforeInput hook to place catch-up notes before inputs. Drop the patch when Pi ships input-placement hooks.
- `extensions/conversations/server.ts` — uses the same hook to resume a concluded conversation in the commit that places its input.
- `extensions/coding-tools/diff.tsx` — internal untyped details.patch/details.diff formats drive the diff renderer. Drop when Pi exports structured diff rows for rendering.
- `extensions/prompt/server.ts` — tool guidance adapted from unexported prompt contributions, not Ultimate's personality. Drop when Pi exports buildSystemPromptSections and the per-tool system prompt contributions.
- `web/src/app/model.ts` — internal trailing <harness> text block duplicates diagnostics and is stripped for display. Drop when Pi exports a diagnostic-free tool-result content accessor.
- `web/src/sdk/format.ts` — copied formatTokens helper, not exported. Drop when Pi exports formatTokens.
- `web/src/sdk/events.ts` — adapted Pi event bus using browser-safe sets instead of node:events, with Pi's exported EventBus type and handler-error semantics. Drop when Pi ships a browser-safe bus.
- `extensions/coding-tools/web.tsx` — internal bash exit_code diagnostic message drives exitOf and untyped details.patch/details.diff drive Edit. Drop when Pi exports structured bash outcomes and structured diff rows for rendering.
- `extensions/self/web.tsx` — internal remove-all pi.system entry immediately precedes a reordered re-add, hidden here. Drop when Pi exposes prompt reorder metadata instead of requiring entry-sequence inference.
- `extensions/fast/server.ts` — sets service_tier through onPayload because pi-ai's simple stream options drop serviceTier. Drop when buildBaseOptions forwards serviceTier and Pi Durable stream settings accept it.
- `server/tool-arguments.ts` — ends degenerate tool-call argument streams with an error worded to match pi-ai's retryable error pattern, so the generation retries it. Drop the wording when Pi Durable lets a stream mark its error retryable.
- `extensions/subagents/server.ts` — internal ToolTaskInput.assistant locates the calling assistant for history forks. Drop when ToolExecutionApi exposes the calling assistant entry ID.

On a Pi upgrade, run `rg "Pi upstream:"` and recheck each marked item against the new version; test/e2e/pi-upstream.test.ts checks that every tracked marker matches the installed package version and its path appears in this list, and every backticked path in this list is tracked and contains a marker.
Delete copies and patches that Pi now exports or fixes, then update the remaining markers and this list after verification.

## Reference

- Pi Durable README and examples: `node_modules/@earendil-works/pi-durable/README.md`, upstream
  https://github.com/earendil-works/pi/tree/main/packages/durable
- The durable coding agent this host follows: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/experimental/durable
