# Hashline A/B (fork-only tooling)

Run Ultimate's current edit tools against configurable extension arms on oh-my-pi's 106 edit tasks. This runner does **not** implement hashline. Do not recommend it from the two-task smoke: both real-model arms, three repetitions, and each requested model still need measuring.

## Run

Requires Node 26, pnpm, git, tar, a fully installed Ultimate checkout and existing Pi provider logins. Install the two bench-local dependencies (Prettier for verifier parity and `diff` for line alignment/patches; no application dependency changes):

```sh
cd .ultimate/bench/hashline-ab
npm ci --ignore-scripts
cd ../../..
node .ultimate/bench/hashline-ab/run.ts \
  --arms baseline:,hashline:hashline \
  --models anthropic/claude-sonnet-5-5,openai-codex/gpt-6.1-sol \
  --runs 3 --tasks all --concurrency 1 --out /tmp/hashline-ab-full \
  --ultimate /absolute/path/to/checkout-containing-hashline
```

`--ultimate` defaults to this runner's checkout. The named checkout must contain the built-in `extensions/hashline/` before running arm B. No extensions are copied into task projects. A missing/disabled/broken requested extension fails the run, rather than silently measuring baseline twice. Models are checked against the scratch server's `/api/models`; the two full-matrix IDs above were available on this machine during the spike.

Arms are comma-separated `name:extension+extension` entries; an empty extension list means baseline. The **first arm is A**, every subsequent arm is compared with A. `--tasks all`, `--tasks 2` (first two lexicographically sorted IDs), or `--tasks id,id` select tasks. Defaults: three runs, one worker, all tasks, `--timeout-ms 600000`. Startup has a separate 120-second bound. More workers spend tokens concurrently; this is not a dry run.

Rerun the identical command to resume: finished rows in `results.jsonl` are skipped, including failed/timed-out runs. The manifest rejects changes to arms, models, task selection, repetitions, timeout or checkout revision; use a new output directory for a new experiment. Do not run two invocations against one output directory. A crash before publication repeats that run (and its spend). A torn JSONL row is an explicit parse error, not silently discarded.

```sh
node .ultimate/bench/hashline-ab/report.ts /tmp/hashline-ab-full
node --test .ultimate/bench/hashline-ab/bench.test.ts
pnpm exec tsc -p .ultimate/bench/hashline-ab/tsconfig.json
pnpm check
```

The runner exits 0 when measurements finish (individual verification failures are valid results), 1 for infrastructure/model/timeout errors. A report verdict is not its process exit status. Results and artifacts stay in `--out`; do not commit model transcripts/storage by default. `.ultimate/` is format-checked by `pnpm check`; the explicit bench tsconfig additionally checks these otherwise non-application TS files.

## Driving Ultimate and isolation

Choice **(b): one supervised scratch server per task × arm × repetition × model**, started with `pnpm start <fresh-project> --port <ephemeral-port> --no-open`. The pre-build spike successfully started a server, listed available real models, created a fresh HTTP conversation and read its idle task graph without making a model call. `server/harness.ts:124` prepares a harness, but extension loading/installation is separately wired in `server/main.ts:155`; using only `prepareHarness` would miss the very tools under comparison. The normal server path reuses that wiring and provider auth without a new adapter or any core changes.

For each measurement:

- A new random temp project, a linked worktree of the invocation's shared base checkout (its `.git` is a file pointing there), contains only that task's input files, committed over an empty base commit, and `.ultimate/settings.json`. `git worktree list` or `git log --all` would show sibling runs of the same invocation; both arms share this, so it does not bias the comparison. Never its prompt file, expected files, metadata, other tasks or results. The prompt is submitted verbatim through `/api/conversations/:id/submit` to a new ownerless conversation (`server/api.ts:483,533`). Expected fixtures are extracted into a separate temporary directory, never beneath an agent's project; it is deleted after the invocation.
- A separate random home holds storage. Provider auth remains in the normal Pi home; credentials are neither copied nor printed. Machine configuration still layers underneath project configuration.
- Project config requires explicit trust (`server/project-setup.ts`). The runner trusts one generated checkout through Pi's locking `ProjectTrustStore` API for the whole invocation, and each run project is a linked worktree of it, which shares that decision (`decisionRoot`). trust.json is written twice per invocation, not per run: every running Ultimate watches it. It does not change global settings or trust parent directories. A forcibly killed runner may leave a stale trust decision for a deleted temp checkout.
- Each run's Vite dependency cache (`home/vite`, hundreds of MB) is deleted before its storage is copied into the artifacts.
- The same fixed controls apply to every arm: disable codemode, tailscale, cloud, automations, sounds and update; hashline is disabled unless the arm enables it. **Codemode is deliberately disabled**, with coordinator approval, so every edit invocation/result is visible in the transcript. Nested codemode tool results otherwise are not persisted as toolResult messages; trace rows seal their results (`server/trace.ts:366–390`). This benchmarks today's direct read/edit/write/bash implementations, not codemode orchestration. Enabled arm extensions may override the other fixed disables; never enable codemode in an arm.
- `ULTIMATE_MODEL` pins new agents to the run's model (`server/harness.ts:164–169`, `lib/agents.ts:37–65`); the task conversation is also explicitly configured with that model and low thinking. Background agent model overrides follow the same existing preview-model mechanism. Every arm uses low thinking. Provider caches are **not flushed**; usage records expose cache effects.
- Poll the HTTP SSE initial task graph until all foreground tasks in this isolated server are idle, with a bounded deadline; then shut down its entire process group. Read all persisted entries from its now-closed SQLite storage (including any child conversations), not an agent's final claim. Save transcript, system/extension snapshot, storage, logs, verifier diff and input→output final diff under `runs/…`.

This is project/storage isolation, **not an OS sandbox**: normal Ultimate tools can access absolute paths and the network. The prompts are trusted MIT benchmark data, not adversarial sandbox tests. No task paths or expected content are supplied to the model. Ambient user extensions/settings still affect the normal server and are visible in `system.json`; use the same machine setup for both arms. A small free-port selection/bind race is possible; startup errors are surfaced, never silently retried as another measurement.

## Metrics and pass bars

`results.jsonl` stores one finished run per unique model/arm/task/repetition, including:

- `pass`: same file set (excluding runner-owned `.git`/`.ultimate`) and upstream-style formatted expected/actual equality. Normalize CRLF, restore whitespace-only paired changed lines, collapse excessive blank lines, format with upstream Prettier options (JS uses Flow), ignore blank-line counts for code but not Markdown/YAML. Upstream's raw-content fallback on parser errors is retained. Extra/missing files fail. See `verify.ts`.
- `wrongTarget`: conservative **final-output proxy**, not proof about intermediate writes. Compare raw expected→actual line diffs. The target is the unique expected file whose basename matches metadata `file_path`; allowed expected coordinates are `line_number` through `line_number + original_snippet line count − 1` (camelCase fields also accepted). A non-blank line removed/replaced outside that span, a non-blank insertion anchored outside the span plus its end boundary, or a differing non-target file flags wrong-target; off-target whitespace inside a non-blank line (indentation) counts too, even if formatted verification passes. When only blank lines changed outside the span (a seam left by an otherwise correct edit), the run is recorded as `blankSeam` and reported in its own column instead. `node .ultimate/bench/hashline-ab/rescore.ts <out>` re-scores results recorded before this split from their saved `verifier.diff` (it keeps `results.jsonl.before-rescore`). An unrepaired mutation inside the span fails without being a wrong-target write; a wrong edit later undone cannot be detected from final files. Ambiguous/malformed metadata is an explicit error. All 106 expected trees exercise metadata lookup in tests.
- `input`, `output`, `cacheRead`, `cacheWrite`: sums of persisted assistant `usage` fields across this run's conversations. These are provider-reported tokens, not model prose; output includes any reasoning tokens the provider includes. Missing assistant usage is an error. No inference is made from textual claims.
- `cost`: sum of `usage.cost.total` in USD when present, otherwise null (N/A in report), not an independently audited bill. No extra price-table estimate is substituted. Codex subscription billing may differ from this provider estimate.
- `tools`: assistant toolCall counts by name; `editCalls` counts `edit`, and `editErrors` counts matching toolResult messages with `isError`. Codemode is disabled to avoid hidden nested results. Error rate is total edit error results / total edit calls (zero calls = N/A, not 0%). Bash commands are not reclassified as edit calls.
- `wallMs`: setup, server startup, model work, shutdown and artifact verification time, excluding queue time. The saved `final.diff` is input→actual; `verifier.diff` is expected→actual.

Per model × arm: pass rate, error rate, wrong targets, output/pass, cost/pass, mean wall time. Output/pass and cost/pass include the resources spent on **failed attempts** in the numerator, divided by the number of passing attempts. Zero passes or missing cost means N/A. Comparisons require exactly paired task/repetition sets, independent of completion order. Bars: B pass ≥ A − 2 percentage points; B edit errors ≤ 3%; B wrong targets = 0; B output/pass ≤ 85% of A; B cost/pass ≤ A. Every bar is shown separately. These are descriptive threshold checks, not a statistical non-inferiority confidence test. Per-task cells enumerate repetition outcomes.

## Verified smoke (not the full matrix)

```sh
node .ultimate/bench/hashline-ab/run.ts --arms baseline: \
  --models anthropic/claude-haiku-5-5 --runs 1 --tasks 2 --concurrency 1 \
  --out /tmp/hashline-ab-smoke-9475-final
```

Exit **0**. `smoke/report.md` and `smoke/results.jsonl` preserve the two-task result: **2/2 passed**, **0 edit errors**, **0 wrong targets**, **474.5 output tokens/pass**, **$0.001952/pass**, **13.22 seconds/run**. This used the final trust gate and codemode-disable configuration. The full matrix is 1,272 measurements (106 × 3 × 2 arms × 2 models); smoke timings/prices are Haiku-only, not a Sonnet/Codex forecast. Arm B remains unexercised until hashline is available in the selected checkout.

## Credit and license

`fixtures.tar.gz` is copied unchanged from oh-my-pi, `packages/typescript-edit-benchmark/fixtures.tar.gz` (106 tasks). `verify.ts` adapts its `src/verify.ts`, `formatter.ts` and `shared.ts` to Node, retaining the pass-relevant normalization and formatter options; indent scoring is intentionally omitted. oh-my-pi is MIT licensed; the upstream copyright/permission notice is preserved in `LICENSE.omp`. The fixtures are used solely as benchmark inputs and expected outputs. Prettier 3.8.2 and diff 8.0.4 are bench-local pinned dependencies.
