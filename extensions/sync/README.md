# Sync

@sync's tools in the **machine home**, and the report action it uses in project homes.

## The machine home

Each machine can run one small Ultimate whose project is `~/.ultimate/machine`, a plain folder without Git that never syncs: `ultimate --port 4700 --no-open ~/.ultimate/machine` (`pnpm setup:machine` installs it as `ultimate-machine.service`). `subagents/primary.ts` detects it (`projectRoot === <home>/.ultimate/machine`), on the server and in the browser through system info. There, only definitions with `resident: machine` are standing agents, so @sync (`agents/sync.md`) is its only one; in project homes only `resident: true` ones are. The home's primary agent, @sync there and @ultimate elsewhere, owns the top-bar button, the first sidebar row, chat mode and messages to the user. The machine home starts no onboarding and no root reading.

To preview it without touching the real one, run a faux server with a temporary `HOME` whose project is `$HOME/.ultimate/machine`:

```sh
T=$(mktemp -d) && mkdir -p $T/.ultimate/machine
HOME=$T ULTIMATE_PROJECT=$T/.ultimate/machine ULTIMATE_HOME=$T/state ULTIMATE_FAUX=1 ULTIMATE_PORT=4791 node server/main.ts
```

Send `fleet demo` in @sync's conversation to see the fleet card with a move in flight. `projects()` only lists homes started through the supervisor (`node bin/ultimate.ts <dir> --port <n>`), which writes the port into `ultimate.lock`; unset the inherited `ULTIMATE_*` variables of a running host first.

In the machine home, @sync's empty conversation says what it does and its composer asks "Ask @sync about your machines…" (`intro`), and the status line drops the "set up git" nudge: the folder is not a repository on purpose.

## Ask @sync

`link.tsx` exports `AskSync`, a quiet link the cloud facet shows on a project's standby page and in its status-line popover while this machine's home runs. It calls the `home` action, which finds `~/.ultimate/machine` with a running URL in `host.projects()` (the supervisor's `ultimate.lock` port) and links to @sync's conversation there. In the cloud (`/p/<slug>/`) it shows nothing.

## Tools (machine home only)

- `fleet`: the cloud's `GET /sync/directory` (the user's `cloud.url` with `https`, `Authorization: Bearer <ULTIMATE_CLOUD_TOKEN>`, as `cloud/config.ts` reads them), merged with every local project home from `host.projects()`: `cloud.state` of the running ones over loopback (`POST <url>/api/extensions/cloud/actions/state` with `Origin: <url>`; standby servers answer too), `state.stale-*.sqlite` in each home and `refs/heads/ultimate-moved/*` in each checkout. Returns `{ machine, machines[], projects[{ key, name, writer, standbys, transition?, local? }], error? }` (`types.ts`) and renders as the fleet card. A failed directory read keeps the local projects and names the error. On faux hosts it returns a fixed demo fleet.
- `move { project, to?, force? }`: to this machine (no `to`, or this machine's name) through the local project's `cloud.moveHere`, elsewhere through `POST /sync/move?project=<key> { machine, force? }`. `force` is sent only when given; the prompt allows it only after the user confirmed the missing secrets. Renders the move card, polling the `transition` action.
- `cancel { project }`: the local `cloud.cancel` when this machine runs the move, else `POST /sync/cancel?project=<key>`.
- `report { project, text }`: calls the project's `sync.report` action over loopback.

## Watcher

Every 5 s the machine home reads `cloud.state` of the running local project homes. When a transition with this machine as target or source ends (claim step done, or an error set), it submits one `sync.move` input to @sync's conversation with the transition as typed entry data and requestId `sync-move:<transition id>`, so Pi admits it once across restarts. No model runs for it until a move ends.

## Actions

- `home` (project homes): `{ url }` of this machine's running machine home, @sync's conversation when it exists, or null.
- `transition { project }` (machine home): the project's current move, from its local server or the cloud, for the move card.
- `report { from, text }` (project homes): a one-way `sync.report` input to the project's @ultimate. Refused on standby and in the machine home.
