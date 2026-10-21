Supervised background scripts that wake subscribed conversations when they print `FIRE`. An agent writes and repairs each script; model tokens are used for setup and recovery, not for waiting. Enabled by default as an optional extension; requires core `subagents` and `board`.

## Agent and tool

`subscription create {ask, title?, once?, secrets?, subscribers?}` creates `S<n>` and a normal, ownerless child using `agents/subscription.md`. The caller is subscribed automatically. The child writes and briefly tests its executable, then calls `subscription start {id}`. `once` defaults to true.

Other operations: `list`; `subscribe` / `unsubscribe {id, to?}` (`#id` or `@name`, default caller); `start`, `stop`, `delete {id}`; `log {id, lines?}` (default 50, maximum 2000); `escalate {id, reason}`. Delete stops the process and removes the record, keeping files and the conversation. Tool memo and transactional receipts deduplicate mutations on replay.

## Files and lifecycle

Files live in `~/.ultimate/subscriptions/<project>/S<n>/`: executable `run`, persistent `state/` (passed as `$SUBSCRIPTION_STATE`), and append-only `output.log`, trimmed to about 2000 lines / 256 KiB. `<project>` is `basename(host.home)`, the stable state-home name, not the caller's worktree. Named secrets are read from the Secrets store only for `secrets` names and passed in the process environment; values are never included in the subscription record.

Stdout `FIRE <text>` wakes each subscriber with a `subscriptions.fired` input; text can be JSON. Stderr and other stdout are progress. A one-shot stops after its first fire and becomes done. A one-shot exiting without a fire, a nonzero exit, or any recurring-script exit becomes investigating and wakes only its own agent with `subscriptions.failed` and the last 50 log lines. The agent repairs and restarts, or escalates after two unsuccessful recovery attempts. Escalation sets failed, messages @ultimate from that agent, and wakes subscribers with `subscriptions.escalated`. There is no idle watchdog.

The supervisor keeps process handles in a reload-stable resource and kills process groups on stop, facet reload/disable, release, and shutdown. On open it sweeps recorded pids and restarts enabled running subscriptions. Script state must tolerate restart. The session document `ultimate.subscriptions` stores explicit lifecycle states and lifetime fire counts. Lifecycle events (`subscriptions.started`, `.fired`, `.exited`, `.escalated`) and state changes commit together. Root-owned durable delivery tasks are created in those same transactions; request ids plus `submissionByRequest` deduplicate inputs per subscriber/event.

## Browser API

Actions in `refs.ts` match the tool: create → subscription; list → subscriptions with computed `alive`; subscribe/unsubscribe/start/stop/escalate → subscription; log → `{text}`; delete → `{id}`. Create and default subscriber operations require the caller's `conversationId`. Read the session state through `list`. This extension has no browser facet yet.
