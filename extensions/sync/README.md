# Sync

@sync's tools and feedback: across the fleet in the **machine home**, for one project in each **project home**.

## The machine home

Each machine can run one small Ultimate whose project is `~/.ultimate/machine`, a plain folder without Git that never syncs: `ultimate --port 4700 --no-open ~/.ultimate/machine` (`pnpm setup:machine` installs it as `ultimate-machine.service`). `lib/machine.ts` detects it (`projectRoot === <home>/.ultimate/machine`), on the server and in the browser through system info. There, only definitions with `resident: machine` or `everywhere` are standing agents, so @sync (`agents/sync.md`, `resident: everywhere`) is its only one; in project homes the `true` and `everywhere` ones are, so @sync stands next to @ultimate, with the arrows mark in the sidebar. The home's primary agent, @sync there and @ultimate elsewhere, owns the top-bar button, the first sidebar row, chat mode and messages to the user. The machine home starts no onboarding and no root reading.

To preview it without touching the real one, run a faux server with a temporary `HOME` whose project is `$HOME/.ultimate/machine`:

```sh
T=$(mktemp -d) && mkdir -p $T/.ultimate/machine
HOME=$T ULTIMATE_PROJECT=$T/.ultimate/machine ULTIMATE_HOME=$T/state ULTIMATE_FAUX=1 ULTIMATE_PORT=4791 node server/main.ts
```

Send `fleet demo` in @sync's conversation to see the fleet card with a move in flight. `projects()` only lists homes started through the supervisor (`node bin/ultimate.ts <dir> --port <n>`), which writes the port into `ultimate.lock`; unset the inherited `ULTIMATE_*` variables of a running host first.

In the machine home, @sync's empty conversation says what it does and its composer asks "Ask @sync about your machines…" (`intro`), and the status line drops the "set up git" nudge: the folder is not a repository on purpose.

## Ask @sync

`ui.tsx` has `AskSync`, a quiet link sync provides for cloud's `MoveHelp` point, which the cloud facet shows on a project's standby page and in its status-line popover while this machine's home runs. It calls the `home` action, which finds `~/.ultimate/machine` with a running URL in `host.projects()` (the supervisor's `ultimate.lock` port) and links to @sync's conversation there.

## Tools

The same four tools in both homes. In the machine home they reach every machine and project; in a project home they see only this project: its own home, reached at its own address (`system().process.url`, since `host.projects()` marks it `current`), is the only local one they read, and `fleet` keeps only this project and the machines that run it. `move`, `cancel` and `backup` there resolve the name against that scoped fleet first and refuse any other project before a request goes out.

- `fleet`: the cloud's `GET /sync/directory` (the user's `cloud.url` with `https`, `Authorization: Bearer <ULTIMATE_CLOUD_TOKEN>`, as `lib/cloud.ts` reads them), merged with every local project home from `host.projects()`: `cloud.state` of the running ones over loopback (`POST <url>/api/extensions/cloud/actions/state` with `Origin: <url>`; standby servers answer too), `state.stale-*.sqlite` in each home and `refs/heads/ultimate-moved/*` in each checkout. A running home's `local.login` is `{ provider, ok }` from its `cloud.state`, the model login its agents run with; the card shows an amber "no model login" line when it is not ok, or "<provider> failing: <error>" when the login is configured but its latest call failed (`extensions/health`). Each of `machines[]` carries `health` (`ProviderHealth[]`): this machine's from its own `~/.ultimate/health.json`, so it is fresh, and every other machine's as it last reported it to the cloud's `GET /sync/health`; a machine that only reports health shows offline with no projects. A failed health read is ignored, the directory's error covers cloud trouble. The card shows one provider line per machine under its header, in the cloud front page's wording: `openai-codex ✓ 12m · anthropic ✗ invalid_grant 3h · claude-code ?`. Returns `{ machine, machines[], projects[{ key, name, writer, standbys, transition?, local? }], error? }` (`types.ts`) and renders as the fleet card. A local home matches the directory by the key the cloud admitted it under (`cloud.state`'s `key`, the replica's own key after a relink), falling back to its GitHub origin's key; `local.origin` keeps the origin key when the two differ, and `move`, `cancel` and `backup` accept either. A failed directory read keeps the local projects and names the error. On faux hosts it returns a fixed demo fleet.
- `move { project, to?, force? }`: to this machine (no `to`, or this machine's name) through the local project's `cloud.moveHere { by: 'sync' }`, elsewhere through `POST /sync/move?project=<key> { machine, force? }`; both record the move as started by @sync. `force` is sent only when given: it continues past missing secrets and makes the writer release without waiting for running conversations or uncommitted worktrees; the prompt allows it only after the user confirmed. Renders the move card, polling the `transition` action.
- `cancel { project }`: the local `cloud.cancel` when this machine runs the move, else `POST /sync/cancel?project=<key>`.
- `backup { project }`: the local project's `cloud.backup` over loopback (10-minute timeout), only when its home on this machine is the writer; otherwise it names the writer. Returns `{ key, id, at, bytes }` once uploaded. The fleet card shows `last backup 3h ago` under each project: this machine's own `cloud.state` `lastBackup` when it writes the project, else the directory's `lastBackupAt`, which the writer reports in hello and with each backup.

## Feedback (project homes)

One report per event, in the project's own @sync conversation. Sync implements two extension points there, which the writer's code calls; nothing reaches @sync while the project is on standby, where its storage is closed.

- **Backups** (`cloud.feedback`'s `backup`, called by the lease when a backup finishes or fails): a `sync.backup` entry with the project and the report. A finished backup is a note (a write, which does not wake @sync) with "Backed up · 12.0 MB · 3.2s"; a failed one is an input that wakes it, with the reason. requestId `sync-backup:<snapshot id>` or `sync-backup:failed-<time>`.
- **Moves** (`cloud.feedback`'s `moved`, called once a move to this machine claimed the lease and opened storage): a `sync.move` input that wakes @sync to run the health check, requestId `sync-move:<transition id>`. Its text names who started the move ("started from the cloud UI", "by @sync", …).
- **Provider health** (`health.feedback`'s `failing`): the health file's write that turns a provider failing (from ok or unknown) reports once, from the home whose call or ping wrote it; later failures of a failing provider report nothing. A `sync.health` input, requestId `sync-health:<provider>:<time>`.

The writer socket's connected/offline changes are not routed: @sync reads them with `fleet`. Nothing reaches @ultimate.

## Watcher (machine home)

A move that failed on its way to this machine leaves the project's home on standby, without storage, so the machine home reports it instead. Every 5 s the machine home reads `cloud.state` of the running local project homes; for each failed transition targeting this machine whose home is not the writer, it submits one `sync.move` input to its own @sync, requestId `sync-move:<transition id>`, so Pi admits it once across restarts. A finished move reports only in the project's home (above), also once the project later moves on and this home keeps that move as `ran`; a move away from this machine reports on its target.

Each tick considers both transitions `cloud.state` names: `transition` (the move this machine runs, or else the latest one the cloud reported) and `ran` (the last move this machine ran itself, kept in memory by the project home's lease even after a newer move replaces it in the cloud). A failed attempt retried within 5 s wakes @sync only for the retry. A failed move whose project home restarts before the next tick is not seen, because `ran` lives in the project home's memory: run `fleet` to see the latest moves.

## Join your fleet

On a machine without cloud sync (`cloud.url` or either secret missing), @sync's empty conversation shows the **Join your fleet** card under its intro (`intro.card`), in the machine home and in project homes; ⌘K → **Join cloud fleet** opens it in a dialog anywhere. It takes the cloud URL (`wss://` or `https://`), the machine name (prefilled with `cloud.machine` or the hostname) and the two secrets, as password fields without a `<form>`, like the Secrets panel. Submit calls the user-only `join` action (`join.ts`):

1. The URL becomes `wss://<host>` (a loopback `ws://`/`http://` URL stays `ws://`, for `pnpm cloud:dev`), and the machine name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
2. `GET https://<host>/sync/directory` with the bearer token: 200 passes; 401 answers "The cloud refused the token"; anything else "Cannot reach <host>". Nothing is stored on failure.
3. Both secrets go through the secrets extension's `SecretsApi.set` (the store the Secrets panel writes), then `cloud.url` and `cloud.machine` merge into `~/.ultimate/settings.json`, keeping other keys.
4. It returns the cloud's project names.

The card shows the steps (Check cloud → Save secrets → Save settings → Done) like the move card, the error under the failed step, and on success a Next block: `pnpm setup:machine` to copy, a restart of Ultimate and the machine home (the cloud facet reads its config once when it starts), and the cloud's projects. A re-run with the same values passes. Once joined, the card reads "Joined as <machine> · <host>" with a Change link; the empty conversation then shows no card. Secret values never reach a model, the trace (`token`/`snapshotKey` are redacted) or the transcript, and agents cannot call `join`.

## Actions

- `home` (project homes): `{ url }` of this machine's running machine home, @sync's conversation when it exists, or null.
- `transition { project }`: the project's current move, from its local server or the cloud, for the move card.
- `joinState`: `{ joined?: { url, host, machine }, url?, machine, missing }`, this machine's cloud setup without secret values.
- `join { url, machine, token, snapshotKey }` (user-only): the Join card's submit, above.
