# Pilot results

Measured on 2026-10-12 with `openai-codex/gpt-6-luna`, thinking `high`, one worker, no retries.
All five scenarios passed in three consecutive `pnpm eval` runs: **114.09s / 87.37s / 76.09s**.
These suite durations include startup and cleanup. Turn times below measure HTTP submission through idle.
Tokens are summed assistant-message usage for the tested conversation, including cache tokens;
seed messages have zero usage. Continuity includes its follow-up turn. No judge or subagent calls ran.

| Scenario                       | Run 1 seconds / tokens | Run 2 seconds / tokens | Run 3 seconds / tokens | Pass rate       |
| ------------------------------ | ---------------------- | ---------------------- | ---------------------- | --------------- |
| History continuity + follow-up | 18.908 / 35,788        | 8.353 / 28,299         | 13.784 / 36,020        | 3/3             |
| Coding loop                    | 28.728 / 37,600        | 11.403 / 37,153        | 7.811 / 37,331         | 3/3             |
| Seeded bash failure            | 22.464 / 28,838        | 13.913 / 35,743        | 12.081 / 29,202        | 3/3             |
| Weekday automation             | 36.004 / 112,265       | 44.894 / 123,477       | 35.187 / 128,412       | 3/3             |
| Codemode extension inspection  | 4.186 / 15,140         | 5.102 / 18,732         | 3.466 / 18,755         | 3/3             |
| Total measured turns           | 110.290 / 229,631      | 83.665 / 243,404       | 72.329 / 249,720       | 15/15 scenarios |

Usage metadata reports estimated costs $0.01155006 / $0.01128264 / $0.01008608.
Those are model-catalog estimates, not billing records. Automation has the largest prompt/tool budget.
An earlier development run passed four scenarios and failed the automation assertion: the API uses
`expr`/`tz`, not `expression`/`timezone`. The model had created the correct schedule.
Corrected the assertion against `extensions/automations/schedule.ts`; no retries or weakened scheduling checks.
Three runs establish a pilot result, not a long-term reliability guarantee.

## Fixture contract

`start({project: {files, git}, extensions: {enable, disable}, model, thinking})` creates a real embedded server,
with temporary project, Ultimate user config, and SQLite home. Pi's normal `ModelRuntime` owns shared auth.
The default model is checked before creating files or starting the server; overrides must select OpenAI Codex.
`conversation({history})` creates/configures through HTTP, then appends typed Durable entries in one transaction.
`user`, `assistant`, and `toolResult` build Pi messages; only these three roles are accepted in history.
Entry shapes were confirmed by dumping actual faux submissions and a real bash tool result, not guessed.
`run(text)` submits through HTTP, waits for the submission and harness idle, and returns this call's text,
tool calls with matched results/error flags, usage, and wall time. A failed/aborted model turn fails the eval.
`file`, `exec`, and `action` inspect files, git/tests, and public extension actions; `stop` closes and removes state.
Automation's list action reads its durable document through the same action used by the UI.
Workspaces, conversation summaries, status-line, browser, and faux facets are disabled.
No core changes, test deletions, mocks, extra dependencies, or production restarts were needed.

## Replacement proposal — delete nothing yet

References are at the pilot's base `991f33a`. Durations are the ULT-117 scout's whole-file measurements,
not invented per-test timings. Only one existing test is a clear direct behavioral replacement.

| Pilot               | Existing faux coverage                                                        | Proposed removable lines                                         | Time estimate / what stays                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Continuity          | `test/server.test.ts:730`, configure/submit/steer/follow-up/abort             | 0                                                                | Keep HTTP validation and exact admission/abort semantics (whole file 9.42s). New semantic continuity coverage, not a replacement for summaries.                                                                                                        |
| Coding loop         | `test/server.test.ts:704`, SQLite tool turn streamed as ops                   | 0                                                                | Keep committed-view/SSE equivalence. Real repair was not previously tested by this fake output script.                                                                                                                                                 |
| Seeded bash failure | `test/codemode.test.ts:93`, compose read/bash with private nested results     | 0                                                                | Keep nested-result privacy, structured output, error and execution protocol (whole file 6.90s). Eval adds interpreting an earlier error.                                                                                                               |
| Weekday automation  | `test/automations.test.ts:352-380`, creates automation through faux tool call | ~29                                                              | Candidate replacement after review: tool choice + persisted schedule now tested end to end. Estimated <1s saving, not measured; whole file 16.17s. Keep all scheduling, pause/overlap/abort, reopen/catch-up, failed delivery and one-shot invariants. |
| Codemode inspection | `test/codemode.test.ts:180-232`, inspect runtime APIs                         | 0 initially; ~10-20 behavioral assertion lines only if separated | Keep API inventory, pre-reset history, document and model metadata correctness. Eval covers choosing introspection and explaining it, not every API. Saving likely <1s; not independently timed.                                                       |

Initial retirement estimate: **29 lines and less than one second**, pending review; no whole files should be removed.
The eval suite adds roughly 76–114 seconds when opted into. This pilot improves behavior coverage, not test speed.
Keep exact crash/race/replay tests in codemode, plan, automations, subagents, and workspaces;
all storage/accounting tests; all browser/UI tests; supervisor, instance, lock, and process tests;
and server HTTP security, streaming, lifecycle, and transactional document invariants.
These require deterministic scheduling or failure injection and cannot be proved by a cooperative real model.

## Verification and open questions

`pnpm check` passed. `pnpm exec tsc -b evals/tsconfig.json` independently typechecks the evals,
which the root TypeScript include intentionally does not cover.
`pnpm test evals --passWithNoTests` exited 0 with `No test files found`, confirming ordinary tests exclude evals.
No `test/` files changed, so no touched ordinary test files existed to rerun; the full suite was deliberately
not rerun per task instructions. ULT-117 reports the unchanged base suite's 467/467 passing tests.

- When should paid evals run in CI, and where will Codex auth live? Currently they are explicit opt-in.
- Pi global prompt/skills/settings remain real machine inputs; latency and behavior can vary across machines.
- Should CI include `tsc -b evals/tsconfig.json` alongside the opt-in eval command?
- Delegation and rubric judging were omitted: five meaningful must-pass scenarios suffice for the pilot,
  without additional child/judge token costs. A later delegation fixture must include child usage in totals.
- The workspace rewrite may change server creation/submission internals; verify this fixture after landing both tasks.
