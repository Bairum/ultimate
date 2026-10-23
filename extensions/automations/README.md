Durable schedules and supervised scripts, with actions that start prompt runs or wake subscribed conversations. One `automation` tool and session ledger; requires core `subagents` and `messages`. Scripts use tokens for setup and repair, not waiting; prompt runs cost tokens on every fire.

The supervisor terminal dashboard shows `automations/scheduler: ready · durable scheduler` after the harness opens.
This facet-scoped status reports availability, not idleness or run counts; it adds no polling and does not change the
root-owned durable scheduler. It disappears when the extension is disabled or the core is released/stopped.

## Triggers

- `cron "0 9 * * 1-5" Europe/Vienna`: five fields (minute, hour, day of month, month, weekday); numbers, lists, ranges and steps. Sunday is 0 or 7. Timezone defaults to the machine's IANA timezone. Restricted day-of-month and weekday fields use cron's OR rule. Search is bounded to eight years, including leap-day schedules. Nonexistent local minutes in the spring daylight-saving gap are skipped (not shifted); a repeated wall-clock match in the autumn hour fires only once.
- `at 2026-12-01T09:00:00Z` or `in 30m`, `in 2h`, `in 1d`: one fire, then disabled. Prefer explicit ISO offsets.
- `every 15m`: elapsed-time interval, at least one second. Units: s, m, h, d.

One background root-owned scheduler per enabled automation commits plan → sleep → fire. Sleep survives restart; overdue fires run once on waking, then recurring schedules continue from now. Run creation, its running record, and the scheduler checkpoint advance atomically. Overlaps are recorded as skipped, not queued. Pause/edit/delete retire the scheduler without stopping running runs. Editing fields other than the schedule preserves the next fire time. Resuming a spent one-shot is refused; update its time first. Delete keeps all run conversations. The session document `ultimate.automations` keeps the last 50 runs per automation.

A script trigger uses `ask` instead of `schedule`. A `watcher` agent writes an executable `run`, briefly tests it, then calls `automation resume {id}`. Stdout `FIRE [text]` fires the automation; stderr and other stdout are progress. `once` defaults to true: its first FIRE atomically makes it done and disabled, then terminates the group. A recurring script may print `DONE [text]` and exit 0 to stop cleanly without a wake or failure. Resume keeps its persistent state. Any other unplanned exit, including a one-shot that never fired, wakes only the watcher to repair or escalate.

## Actions

Each automation has one or both actions: `prompt` starts a fresh run conversation; `subscribers` wakes existing conversations. Without a prompt or explicit subscribers, create adds the caller. A prompt-only automation has no subscribers. Both trigger kinds share `fire`: increment lifetime `fires`, set `lastFireAt`, emit `automations.fired {id, text, fire}`, create a run when requested (overlap skips that run only), and create one durable delivery task for all subscribers. Each subscriber receives an `automations.fired` input with data `{id, name, text}`. A nonempty FIRE payload is appended to the run prompt as `\n\nFired: <text>`.

## Agent and tool

The one replay-safe `automation` tool supports 13 operations: `list`, `create`, `update`, `pause`, `resume`, `run`, `runs`, `log`, `abort`, `escalate`, `subscribe`, `unsubscribe`, `delete`. Create uses flat arguments `{name, schedule?|ask?, once?, secrets?, prompt?, agent?, model?, thinking?, subscribers?, scope?, slug?}`. Exactly one trigger is required. New user ids are `A<n>`; project scripts use lowercase slugs. Project-scope schedules are rejected. Mutation receipts and tool memo prevent duplicate effects on replay; process receipts target the previous pid and reuse their committed replacement on replay.

`update {id, name?, schedule?, ask?, once?, secrets?, prompt?, agent?, model?, thinking?}` keeps the trigger kind. Pause retires a scheduler or stops a process; resume enables it (scripts require an executable). Run fires a schedule now, or relaunches a script. `runs {id}` reads run history; `abort {id, runId}` aborts a running prompt run. `log {id, lines?}` reads output (default 50, maximum 2000). `subscribe` / `unsubscribe {id, to?}` use `#id` or `@name`, default caller. `escalate {id, reason}` fails a script, notifies subscribers with `automations.escalated` and messages @ultimate from its watcher. Delete keeps files and conversations.

The watcher is a normal ownerless conversation labelled `watcher`, titled `${id} · ${name}`, using `agents/watcher.md`. It receives `automations.writing` on create and `automations.failed` with the last 50 output lines on failure. It repairs and resumes, or escalates after two unsuccessful attempts. There is no idle watchdog.

An optional `agent` selects a shared Markdown agent definition discovered exactly as in subagents (clone, user, project). Runs use its instructions, tool subset (minus automation and subagent), model and thinking. Thinking is clamped to the selected model; the definition's isolate is ignored. Unknown names are rejected on create/update; a definition removed before firing produces a failed run. Write new project profiles in `.ultimate/agents/<name>.md`. The shared `createChild` and `definitionAgent` helpers provide configuration. Without a profile, runs copy the root agent except for the automation tool/extension. Optional model `{provider,modelId}` and thinking override either configuration.

Each run task owns its new conversation, labelled `automation`, titled with the automation name and local fire time. It submits the prompt with a stable task-derived request id, awaits its answer and records status plus the first answer line (200 characters). Aborting a run task cascades to its conversation. The enabled schedules contribute only stable name/schedule lines to the prompt.

## Files and lifecycle

User scripts live in `~/.ultimate/automations/<project>/<id>/`: executable `run`, persistent `state/`, `output.log` (about 2000 lines / 256 KiB), and `pid`. `<project>` is `basename(host.home)`, not a worktree cwd. Environment variables are `AUTOMATION_ID` and `AUTOMATION_STATE`. Only named `secrets` are read from Secrets and injected into the child environment; records never contain their values.

The supervisor uses the reload-stable `automations.supervisor` resource. Every spawn waits behind the existing process-group handshake until its pid is written; EOF before go runs nothing. Pause, relaunch, delete, disable/release and shutdown share SIGTERM → three-second grace → SIGKILL cleanup. The pid file is removed only after the whole group is gone. On open it sweeps every runtime pid, including deleted records, then restarts enabled running scripts. Script state must tolerate restart. A fired one-shot is already done before termination, so reopening cannot re-arm it; its eventual exit still records metadata and an event without reporting failure.

The single v1 session document `ultimate.automations` stores both trigger kinds. Lifecycle events are `automations.started`, `.fired`, `.done`, `.exited`, `.escalated`. Durable `ultimate.automation-delivery` tasks commit with state changes; request-id dedupe in Pi's atomic submit prevents duplicate subscriber inputs. No old records or files are imported.

## Project automations

Commit shared scripts in:

```text
<project>/.ultimate/automations/<slug>/
  run                 executable, committed
  automation.json     {"name":"…","ask":"…","once":false,"secrets":["GH_TOKEN"]}
```

The manifest needs `ask`; `name` defaults to its first 80 characters, `once` to true. Secrets are names, never values. Slugs match `^[a-z][a-z0-9-]*$` (maximum 63 characters, excluding inherited object keys) and cannot collide with `A<n>`. Runtime state stays machine-local under `~/.ultimate/automations/<project>/<slug>/`.

Discovery runs only for a project chosen as local, on open, list, status and slug operations. A new manifest creates a stopped record and idle watcher; it never starts itself. Resume starts it, then enabled running scripts restart on reopen. Changed manifests update records; removed folders or revoked trust stop and forget them. Delete forgets the local record, not the committed folder, so it can be rediscovered. `run` executes from the host checkout in the project root. A watcher's repairs edit the committed file in place and report it as uncommitted; branch edits take effect after landing.

## Service

`AutomationsApi` in `api.ts`, token `automations`, offers `resume(id)`, `pause(id)`, `run(id)`, `status(id)`, each returning the record with computed `alive`. This optional extension is accessed with `want`; external project extensions use `host.want({name:'automations'})`. Mutating methods commit: call outside transactions; from a reactor, do not await them, and report rejection with `.catch`.

## Browser API

`POST /api/extensions/automations/actions/<operation>` with `{args: {...}}` returns `{result}`. Actions match the tool: list → records with `alive`; create/update/pause/resume/subscribe/unsubscribe/escalate → record; run → run (schedule) or record (script); runs → run array; log → `{text}`; delete/abort → `{id}`. A subscriber-only schedule's manual run returns `{id}`. Create and default subscriber operations need the caller's conversation id.

The two non-tool actions remain: `describe {schedule}` → `{schedule, description, next}` (up to three fire times), and `script {id}` → `{path, text}` (first 64 KiB, empty before writing). Schedule actions accept strings or structured schedules. Read session state through list/runs; it is not exported as a conversation doc. `list`, `log`, `script` are poll actions.

## Overview

Both triggers share one state word and dot (`parts.tsx` `lookOf`): failed (red: a failed or escalated script, or an enabled schedule whose last run failed), investigating (yellow), writing or working (purple), watching or scheduled (green), paused and done (grey). Worst first is the order everywhere.

The Automations right-panel tab (after Activity; palette: "Automations…") lists every automation worst first, then newest: a kind icon (clock for a schedule, radar for a script), its name, the schedule in words from `describe` (a one-shot as a local time) or the script's ask, the state line (next run and last result, or uptime and fires, or the error), what a fire does (wakes #id, runs a prompt), an enable switch (pause/resume), Run now (a schedule; off while a run works) or Restart (a script), and Edit and Delete in its menu. Delete asks first and says the conversations are kept. A script row's "script" opens its watcher in the middle and, beside it, the script detail: facts (pid, uptime, exit, fires), the run path, the error, and the live output tail with FIRE lines marked or the script source; "Automations" goes back to the list. The panel follows the shown conversation: a watcher shows its script.

The Agent sidebar's Automations section (`sidebar.top`) shows up to five active automations worst first, hidden when none is; its count turns red while one needs attention and opens the panel. A row opens a script beside its watcher, a working or failed run's conversation, else the panel. The status-line chip counts active automations, coloured by the worst, and opens the panel. The chip, sidebar, panel and cards share one `list` poll at the fastest rate any asks for.

The transcript renders the `automation` call (action, id or name, the ask or prompt, a link to it) and the four inputs `automations.fired`, `.failed`, `.escalated`, `.writing` as folding cards with an "open" button. The switch of a one-shot whose time has passed stays off, since resuming it would fire at once. Expanding an automation lists its runs, newest first: status, fire time, the first answer line, and "open #id", which shows the run conversation as the Agents tab does; a running run shows as working with its elapsed time.

New automation and Edit open one form. New first asks the trigger: "When something happens" takes what to watch for in plain words (the ask), whether to keep watching after the first fire, "Wake this conversation" (on by default) and an optional prompt with the agent picker; Edit keeps the trigger kind and the subscribers. "On a schedule" takes name, prompt, and schedule, either a preset (every weekday at 9, every hour, in 30 minutes) or the raw forms (cron with a timezone, at `in 30m` or a local date and time, every), with a live preview of the next runs from `describe` and how many runs a day that means. The agent picker lists the agent definitions with their models, or a copy of the main agent; Configure opens the chosen definition's config in the subagents extension over the bus (`subagents:open-definition`), then refetches and takes focus back on `subagents:definition-closed`. A note says each run uses the model and costs tokens.

Besides polling, the list refetches when automation tasks change in the live task graph, when a run or watcher conversation appears or settles, while a shown next run is overdue, and on window focus.
