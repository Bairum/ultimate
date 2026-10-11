Durable schedules for agent prompts, with every run kept as a conversation. Opt-in; requires the `subagents` extension enabled. Runs use model tokens, so pause schedules you do not need.

Enable `automations` and `subagents` in `extensions.enable`. This repository enables both; automations is not in the default set.

## Schedules

- `cron "0 9 * * 1-5" Europe/Vienna`: five fields (minute, hour, day of month, month, weekday); numbers, lists, ranges and steps. Sunday is 0 or 7. Timezone defaults to the machine's IANA timezone. Restricted day-of-month and weekday fields use cron's OR rule. Search is bounded to eight years, including leap-day schedules. Nonexistent local minutes in the spring daylight-saving gap are skipped (not shifted); a repeated wall-clock match in the autumn hour fires only once.
- `at 2026-12-01T09:00:00Z` or `in 30m`, `in 2h`, `in 1d`: one fire, then disabled. Prefer explicit ISO offsets.
- `every 15m`: elapsed-time interval, at least one second. Units: s, m, h, d.

One background root-owned scheduler per enabled automation commits plan → sleep → fire. Dormant scheduling does not block workspace landing or cleanup. A due fire waits durably for core workspace lifecycle reservations before creating a run, without consuming the scheduled event; manual Run now refuses the reservation. Actual run creation and child prompt submission use core admission, and live runs block workspace mutation. Preparation/discard failures are recorded as failed runs without child model input. The factory requires the core workspace admission capability. Sleep survives restart; overdue fires run once on waking, then recurring schedules continue from now. Run creation, its running record, and the scheduler checkpoint advance atomically. Overlaps are recorded as skipped, not queued. Pause/edit/delete retire the scheduler without stopping running runs. Editing fields other than the schedule preserves the next fire time. Resuming a spent one-shot is refused; update its time first. Delete keeps all run conversations. The session document `ultimate.automations` keeps the last 50 runs per automation.

## Agent and tool

The `automation` tool supports `list`, `create`, `update`, `pause`, `resume`, `run`, `runs`, `delete`, and `abort` (id and runId). Create requires name, prompt and schedule; subsequent operations use `A<n>`. Mutation receipts and `api.memo` prevent duplicate tool effects on replay.

An optional `agent` selects a shared Markdown agent definition discovered exactly as in subagents (clone, user, project). Runs use its instructions, tool subset (minus automation and subagent), model and thinking. Thinking is clamped to the selected model; the definition's isolate is ignored. Unknown names are rejected on create/update; a definition removed before firing produces a failed run. Write new project profiles in `.ultimate/agents/<name>.md`. The shared `createChild` and `definitionAgent` helpers provide configuration. Without a profile, runs copy the root agent except for the automation tool/extension. Optional model `{provider,modelId}` and thinking override either configuration.

Each run task owns its new conversation, labelled `automation`, titled with the automation name and local fire time. It submits the prompt with a stable task-derived request id, awaits its answer and records status plus the first answer line (200 characters). Aborting a run task cascades to its conversation. The enabled schedules contribute only stable name/schedule lines to the prompt.

## Browser API

`POST /api/extensions/automations/actions/<operation>` with `{args: {...}}` returns `{result}`. Operations match the tool and return JSON: list → automation array; create/update/pause/resume → automation; run → run; runs → run array; delete → `{id}`; abort → `{id}`. create and update take `name`, `prompt`, `schedule`, and an optional `agent` naming an agent definition (update with `agent: ""` goes back to a copy of the root agent), plus the optional `model` and `thinking` overrides; the other operations take `id` (and abort a `runId`). Each automation record carries the same `agent` field when one is set. `schedule` accepts either a tool string or a structured schedule. `describe` accepts `{schedule}` and returns `{schedule, description, next: number[]}` (up to three upcoming timestamps). The host only streams conversation-scoped documents, so this session document is deliberately not exported in `docs`; clients read it through list/runs actions.

## Overview

The Automations right-panel tab (palette: "Automations…") lists every automation, newest first: its name, the schedule in words from `describe` (a one-shot as a local time), the next run (relative, absolute on hover), the last run's status, an enable switch (pause/resume), Run now (off while a run works), and Edit and Delete in its menu. Delete asks first and says the run conversations are kept. The switch of a one-shot whose time has passed stays off, since resuming it would fire at once. Expanding an automation lists its runs, newest first: status, fire time, the first answer line, and "open #id", which shows the run conversation as the Agents tab does; a running run shows as working with its elapsed time.

New automation and Edit open one form: name, prompt, and schedule, either a preset (every weekday at 9, every hour, in 30 minutes) or the raw forms (cron with a timezone, at `in 30m` or a local date and time, every), with a live preview of the next runs from `describe` and how many runs a day that means. The agent picker lists the agent definitions with their models, or a copy of the main agent; Configure opens the chosen definition's config in the subagents extension over the bus (`subagents:open-definition`), then refetches and takes focus back on `subagents:definition-closed`. A note says each run uses the model and costs tokens.

The list reads the `list` action and refetches when automation tasks change in the live task graph, when a run conversation appears or settles, while a shown next run is overdue, and on window focus. The transcript renders the `automation` tool call as a compact card (action, automation, schedule) with a link to the tab.
