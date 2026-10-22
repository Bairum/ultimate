Supervised background scripts that wake subscribed conversations when they print `FIRE`. An agent writes and repairs each script; model tokens are used for setup and recovery, not for waiting. Enabled by default as an optional extension; requires core `subagents` and `messages`.

## Agent and tool

`subscription create {ask, title?, once?, secrets?, subscribers?}` creates `S<n>` and a normal, ownerless child using `agents/subscription.md`. The caller is subscribed automatically. The child writes and briefly tests its executable, then calls `subscription start {id}`. `once` defaults to true.

`scope: 'project'` (default `user`) creates a project subscription instead, with optional `slug`, otherwise derived from the title; see below.

Other operations: `list`; `subscribe` / `unsubscribe {id, to?}` (`#id` or `@name`, default caller); `start`, `stop`, `delete {id}`; `log {id, lines?}` (default 50, maximum 2000); `escalate {id, reason}`. Delete stops the process and removes the record, keeping files and the conversation. Tool memo and transactional receipts deduplicate mutations on replay.

## Files and lifecycle

Files live in `~/.ultimate/subscriptions/<project>/S<n>/`: executable `run`, persistent `state/` (passed as `$SUBSCRIPTION_STATE`), and append-only `output.log`, trimmed to about 2000 lines / 256 KiB. `<project>` is `basename(host.home)`, the stable state-home name, not the caller's worktree. Named secrets are read from the Secrets store only for `secrets` names and passed in the process environment; values are never included in the subscription record.

Stdout `FIRE <text>` wakes each subscriber with a `subscriptions.fired` input; text can be JSON. Stdout `DONE [text]` followed by exit 0 stops a recurring subscription cleanly (a one-shot ignores it), for example a poller once nothing is left to watch: it becomes stopped and disabled, the same state as `stop`, emits `subscriptions.done` (`{id, text?}`) and wakes no one, not even its agent. `start` resumes it later with `state/` kept. A `DONE` followed by a non-zero exit is a failure like any other. Stderr and other stdout are progress. A one-shot becomes done in its first FIRE transaction, then stops; a crash before termination cannot re-arm it. Its pid remains available to stop/delete until the group is gone, and its eventual exit records metadata and an event without reporting a failure. A one-shot exiting without a fire, or any recurring-script exit, becomes investigating and wakes only its own agent with `subscriptions.failed` and the last 50 log lines. The agent repairs and restarts, or escalates after two unsuccessful recovery attempts. Escalation sets failed, messages @ultimate from that agent, and wakes subscribers with `subscriptions.escalated`. There is no idle watchdog.

The supervisor keeps process handles in a reload-stable resource. Every spawn starts a shell waiting for a go line on stdin. The supervisor synchronously writes `pid` before sending go and closing stdin; EOF before go exits without running the script. The shell uses exec to preserve the pid and process group. Stop, restart, delete, facet reload/disable, release, and shutdown share process-group cleanup: SIGTERM, up to three seconds of grace, then SIGKILL. The pid file is removed only after the group is gone. On open it sweeps every `S<n>/pid`, including deleted subscriptions, then restarts enabled running subscriptions. Script state must tolerate restart. The session document `ultimate.subscriptions` stores explicit lifecycle states and lifetime fire counts. Lifecycle events (`subscriptions.started`, `.fired`, `.done`, `.exited`, `.escalated`) and state changes commit together. Root-owned durable delivery tasks are created in those same transactions; Pi's atomic `submit` request-id dedupe prevents duplicate inputs per subscriber/event.

## Project subscriptions

Like project extensions and agents, a project can commit subscriptions that everyone working on it shares:

```
<project>/.ultimate/subscriptions/<slug>/
  run                 executable, committed
  subscription.json   {"title": "…", "ask": "…", "once": false, "secrets": ["GH_TOKEN"]}
```

`ask` is required; `title` defaults to the ask's first 80 characters, `once` to true, and `secrets` are names only, never values. The slug (`^[a-z][a-z0-9-]*$`, at most 63 characters) is the id on every machine, so it never collides with a user `S<n>`. The runtime stays machine-local in the same place as a user subscription's, `~/.ultimate/subscriptions/<project>/<slug>/` (`state/`, `output.log`, `pid`), and the record lives in the session document keyed by the slug, with its enabled state, fires, subscribers and agent conversation.

Project subscriptions load only when the project is chosen as local, the same trust rule as `.ultimate/extensions/` (see `docs/settings.md`). They are discovered on open, `list`, `status` and any slug operation. A new folder becomes a stopped subscription with an idle, ownerless agent conversation configured from @ultimate's agent; it never starts by itself, so a fresh clone does not begin polling unasked. An agent, an extension (`want({name:'subscriptions'})?.start('<slug>')`) or the Start button starts it; after that, it is restarted on reopen like any enabled subscription. A changed manifest updates the record; a removed folder, or a project no longer chosen, stops it and forgets the record. `delete` forgets only the local record; the folder rediscovers it. `run` starts in the project root and runs from the host checkout, so an edit made in a branch takes effect once it lands. When its agent repairs `run`, it edits the committed file in place and says the change is uncommitted.

## Service

`SubscriptionsApi` in `api.ts` lets another extension drive a subscription without an agent, by `S<n>` or slug: `start(id)`, `stop(id)` and `status(id)`, each returning the subscription with `alive`. Subscriptions is optional, so `want` it and handle `undefined`. Start and stop commit, so never await them inside a transaction, such as a reactor's handler; call them from an action, or start them from a reactor without awaiting, with a `.catch` that reports the error. A project extension in `.ultimate/extensions/` outside the clone cannot import `api.ts`; it passes a token of the same name, `host.want({ name: 'subscriptions' })`. For example, an extension that reacts to `subscriptions.fired` to store a PR list restarts its stopped poller with `start('S3')` when a new PR opens.

## Browser API

Actions in `refs.ts` match the tool: create → subscription; list → subscriptions with computed `alive`; subscribe/unsubscribe/start/stop/escalate → subscription; log → `{text}`; delete → `{id}`. `script {id}` → `{path, text}` reads the executable for display (UI only, no tool operation). Create and default subscriber operations require the caller's `conversationId`. Read the session state through `list`. `list`, `log` and `script` are poll actions.

## UI

The Subscriptions panel in the right sidebar (a tab after Activity, or ⌘K "Subscriptions…") follows the shown conversation. Beside any conversation it lists every subscription with a status dot: purple writing, green running, yellow investigating, red failed, grey stopped or done. Selecting one shows its agent's conversation in the middle, which you can talk to in order to refine it, and the panel then shows that subscription: id, title, scope, one-shot or recurring, subscribers, and its script: status, pid, uptime, fires, `run` path, error, the live output tail with `FIRE` lines marked, the script source, and Start/Stop. It polls every 2 s while open in a visible tab. Opening a subscription anywhere (a WATCHING row in the left sidebar, a transcript card, the tool card) does the same: its agent in the middle, the panel beside it. The WATCHING heading folds the section; its count opens the panel. A status-line chip counts subscriptions coloured by the worst state and opens the panel; it hides when there are none. Transcript cards render `subscriptions.fired`, `.failed`, `.escalated` and `.writing` inputs, and the `subscription` tool has its own card.
