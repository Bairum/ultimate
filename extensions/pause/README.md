Pause the whole Ultimate host and continue it with Play. This is a soft pause: running work (a bash call, a model response) finishes on its own, nothing new starts after it, and messages you send meanwhile queue until Play. Nothing is killed and no stream is aborted.

## How it works

- **Pause** (`pause`, user-only) holds Pi Durable's task scheduler (`harness.hold()`, from the patch in `patches/@earendil-works__pi-durable@1.3.0.patch`). A running task invocation finishes its current phase and parks as `pending`; no task is reserved until Play. Abort handlers still run, so Stop works while paused. `harness.inspect()` reports `scheduling: 'paused'`.
- The pause is stored in the root's `pause.state` document (`{ paused, since, runs }`) and survives a restart: the `onOpen` callback holds the scheduler again before the server resumes scheduling.
- **Play** (`play`, user-only) leaves one note on each conversation that was mid-turn when paused and still has its run: a `pause.note` write ("Paused for 2h 14m; the run continued after Play."), placed at the run's next step. Its request ID is the pause's start, so a retried Play leaves no second note. Idle conversations get none. Then the scheduler is released.
- `state` returns `{ paused, since, running }`: the foreground tasks still running, each with its conversation, what it runs (`model response` or the tool's name) and when it started. Background waiters (subagent reporters, automation schedulers) never count.

## Timers outside the scheduler

Automation fires are scheduler tasks, so the hold stops them. Timers that start work outside the scheduler `want` `PauseApi` (`api.ts`) and skip while `paused()`:

- the provider heartbeat (`health`);
- the updater's background fetch (`update`);
- cloud backups and moves (`cloud`): `backup`, `moveHere` and a move started by @sync refuse with "Ultimate is paused; press Play first".

## UI

- Status line: a quiet `⏸ Pause`; while work still runs `⏳ Pausing… 3 tasks running` (amber), its popover listing each task with its conversation, what it runs and its age; then `⏸ Paused · safe` with `▶ Play` next to it.
- Under the composer while paused: `Paused — your message runs on Play`.
- ⌘K: **Pause** and **Play**.
- The Play note shows as one amber divider in the transcript.

Try it with faux: send `phases demo`, pause during its `sleep 4` bash call, and watch it go from Pausing… to Paused · safe.
