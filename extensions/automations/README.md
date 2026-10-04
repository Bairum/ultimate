Durable schedules for agent prompts, with every run kept as a conversation. Opt-in; requires the `subagents` extension enabled. Runs use model tokens, so pause schedules you do not need.

Enable `automations` and `subagents` in `extensions.enable`. This repository enables both; automations is not in the default set.

## Schedules

- `cron "0 9 * * 1-5" Europe/Vienna`: five fields (minute, hour, day of month, month, weekday); numbers, lists, ranges and steps. Sunday is 0 or 7. Timezone defaults to the machine's IANA timezone. Restricted day-of-month and weekday fields use cron's OR rule. Search is bounded to 366 days; nonexistent local minutes are skipped, repeated local minutes may fire twice.
- `at 2026-12-01T09:00:00Z` or `in 30m`, `in 2h`, `in 1d`: one fire, then disabled. Prefer explicit ISO offsets.
- `every 15m`: elapsed-time interval, at least one second. Units: s, m, h, d.

One background root-owned scheduler per enabled automation commits plan → sleep → fire. Sleep survives restart; overdue fires run once on waking, then recurring schedules continue from now. Run creation, its running record, and the scheduler checkpoint advance atomically. Overlaps are recorded as skipped, not queued. Pause/edit/delete retire the scheduler without stopping running runs. Delete keeps all run conversations. The session document `ultimate.automations` keeps the last 50 runs per automation.

## Agent and tool

The `automation` tool supports `list`, `create`, `update`, `pause`, `resume`, `run`, `runs`, `delete`, and `abort` (id and runId). Create requires name, prompt and schedule; subsequent operations use `A<n>`. Mutation receipts and `api.memo` prevent duplicate tool effects on replay.

An optional `agent` selects a shared Markdown agent definition discovered exactly as in subagents (clone, user, project). Runs use its instructions, tool subset (minus automation and subagent), model and thinking. Thinking is clamped to the selected model; the definition's isolate is ignored. Unknown names are rejected on create/update; a definition removed before firing produces a failed run. Write new project profiles in `.ultimate/agents/<name>.md`. The shared `createChild` and `definitionAgent` helpers provide configuration. Without a profile, runs copy the root agent except for the automation tool/extension. Optional model `{provider,modelId}` and thinking override either configuration.

Each run task owns its new conversation, labelled `automation`, titled with the automation name and local fire time. It submits the prompt with a stable task-derived request id, awaits its answer and records status plus the first answer line (200 characters). Aborting a run task cascades to its conversation. The enabled schedules contribute only stable name/schedule lines to the prompt.

## Browser API

`POST /api/extensions/automations/actions/<operation>` with `{args: {...}}` returns `{result}`. Operations match the tool and return JSON: list → automation array; create/update/pause/resume → automation; run → run; runs → run array; delete → `{id}`; abort → `{id}`. `schedule` accepts either a tool string or a structured schedule. `describe` accepts `{schedule}` and returns `{schedule, description, next: number[]}` (up to three upcoming timestamps). The host only streams conversation-scoped documents, so this session document is deliberately not exported in `docs`; clients read it through list/runs actions. No web facet is supplied by this backend.
