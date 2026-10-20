# Cloud state sync

The cloud holds each project's writer lease, its move snapshots and the fleet directory. Conversations live on the machines, reached directly over Tailscale. A project is its GitHub repository, so every checkout of it on every machine shares one SQLite-backed Durable Object replica, and exactly one machine, the writer, runs it. The agent loop, the conversations and the credentials stay on the machines. `protocol.ts` is the sync contract; `extensions/cloud/` is the machine side.

## New machine

To add a machine to the projects a deployed cloud already holds. Joining needs no Cloudflare dashboard, no Access
apps, no Worker secrets, no R2 bucket and no deploy from the new machine: those exist once, for the whole fleet, and
[Deploy](#deploy) covers only that first setup. A cloud exists when its URL answers the sync token:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ULTIMATE_CLOUD_TOKEN" https://<hostname>/sync/directory
```

`200` means join with the steps below; `401` means the token is wrong. Follow [Deploy](#deploy) only when the user
confirms that no cloud exists yet. @sync in the machine home guides a join.

1. Clone Ultimate, then in the clone run `pnpm install` and `pnpm link --global`.
2. Set up by hand:
   - [ ] Log in to every model provider on this machine itself: ⌘K → Log in to a provider, or `/login` in `pi`. Never
         copy `~/.pi/agent/auth.json` (or `~/.claude/.credentials.json`) from another machine: OAuth logins rotate
         their refresh token, so the first refresh on one machine revokes the other's copy (`invalid_grant`). Moves
         and snapshots never carry logins.
   - [ ] Add `ULTIMATE_CLOUD_TOKEN` and `ULTIMATE_CLOUD_SNAPSHOT_KEY` in Secrets (⌘K → Secrets), the same values as on
         the other machines. These are static values you chose at deploy time, not rotating logins, so the same value
         works on every machine: read them in the Secrets panel of a machine that has them and enter them here, or copy
         `~/.ultimate/secrets.json` and `chmod 600` it; never print it.
   - [ ] Set the cloud in `~/.ultimate/settings.json`: `{ "cloud": { "url": "wss://<hostname>", "machine": "<machine>" } }`,
         the same `url` as on the other machines and this machine's own name (it defaults to the OS hostname).
   - [ ] Run `pnpm setup:machine` in the clone (`--dry-run` shows the units and commands first). It installs Ultimate
         and the machine home. On Linux these are the systemd user units `ultimate.service` (`--project <dir>`,
         default the clone) and `ultimate-machine.service` (the machine home on port 4700), with linger enabled so
         both start at boot without a login. On macOS they are launchd agents in `~/Library/LaunchAgents`
         (`com.ultimate.app`, `com.ultimate.machine`, logs in `~/Library/Logs/ultimate`), which run while you are
         logged in. Run it again after changing node.
3. Run `ultimate` in a checkout at the same path as on the other machines (a move to a checkout at another path is
   refused). Where the project ends up depends on the checkout's `origin`:
   - **A GitHub origin the cloud knows:** the machine joins as a standby. Until the cloud answers it waits on standby
     ("Waiting for the cloud") without opening any database, however long the cloud is unreachable; only the
     machine whose `cloud-lease.json` names the project, its last writer, opens storage offline. A database already in
     the home stays in place, untouched.
   - **A GitHub origin the cloud does not know:** the project is registered with this machine as its writer, with its
     existing database if it has one, otherwise a fresh state.
   - **No GitHub origin:** the project stays local only; the status line says `local only`.
4. Move a project with **Move here** on a standby's page or in the status line's `on <machine>` popover, or ask @sync.
   The machine fast-forwards its checkout, installs when the lockfile changed, checks its model login and secrets, has
   the writer finish its running tasks and release, downloads the snapshot and takes over; every step shows in the
   move's card on both machines. A writer keeps its project while it runs, idle or not; it releases only for a move
   and when Ultimate stops cleanly, so the next machine takes it without waiting for the first. **Resume here**
   takes a released project back.

## Run locally

No Cloudflare account is needed:

```sh
pnpm install
pnpm cloud:build
```

Create `cloud/.dev.vars` (gitignored):

```dotenv
SYNC_TOKEN=dev
ACCESS_DEV_BYPASS=1
```

`ACCESS_DEV_BYPASS=1` explicitly skips JWT verification for local development. Keep it in `.dev.vars`, which Wrangler does not deploy; never set it on the deployed Worker.

Run `pnpm cloud:dev` and open the printed URL (normally http://localhost:8787). Local Durable Object data persists in `cloud/.wrangler/`; delete it to start over.

`pnpm cloud:build` builds the front page (`front/`), a small React page with the app's Tailwind theme, styles and UI primitives (`web/src/components/ui`), to `dist/front/`. Rebuild after changing it; `wrangler dev` picks up the new files.

Snapshots carry a project's database and branches from one machine to the next (`snapshots.ts`, written by `extensions/cloud/snapshot.ts`). `PUT` and `GET /sync/snapshots/<sha256(project key) hex>/<id>/<name>` with the sync bearer token store and read opaque objects under `snapshots/` in the private `BUILDS` bucket. `<id>` matches `^[a-z0-9-]{8,64}$`, `<name>` is `manifest`, `db-<n>` or `bundle-<n>`, and a body may be at most 17 MiB (413 above). The machine compresses and encrypts every object, the manifest included, so R2 holds only ciphertext and the Worker logs nothing about them. A manifest upload completes a snapshot and prunes the project's prefix: the snapshot just uploaded and the two newest other complete ones stay, older complete ones and partial uploads idle for an hour are deleted. Backups (`cloud.backup`) are snapshots too and count among the three; nothing else prunes them.

### Two-machine check

Sync needs a project whose `origin` is a GitHub remote; the remote is only read, never contacted. Make two checkouts of one throwaway repository, as if on two machines:

```sh
mkdir -p /tmp/demo/a && git -C /tmp/demo/a init -b main
git -C /tmp/demo/a -c user.name=Demo -c user.email=demo@example.com commit --allow-empty -m root
git clone -q /tmp/demo/a /tmp/demo/b
for c in a b; do git -C /tmp/demo/$c remote set-url origin git@github.com:demo/demo-project.git 2>/dev/null \
  || git -C /tmp/demo/$c remote add origin git@github.com:demo/demo-project.git; done
```

Start a faux host in each, with separate temporary state homes, free ports and machine names. From this checkout:

```sh
DEMO_HOME=$(mktemp -d)
ULTIMATE_PROJECT=/tmp/demo/a ULTIMATE_SUPERVISED=0 ULTIMATE_GENERATION=1 \
  ULTIMATE_FAUX=1 ULTIMATE_HOME="$DEMO_HOME" ULTIMATE_PORT=4801 \
  ULTIMATE_CLOUD_URL=ws://127.0.0.1:8787 ULTIMATE_CLOUD_TOKEN=dev \
  ULTIMATE_CLOUD_MACHINE=demo-desk pnpm dev
```

Use `/tmp/demo/b`, port 4802, a different `DEMO_HOME` and `ULTIMATE_CLOUD_MACHINE=demo-laptop` for the second host. Explicit `ULTIMATE_PROJECT` and supervised mode avoid inheriting the agent terminal's host environment. Never reuse the running host's port or state home.

The first host to connect registers the project and becomes its writer (`cloud-lease.json` appears in its home); the second is a standby. The front page shows one row, `demo-project`, running on `demo-desk` with `demo-laptop` as a standby chip. Stop the writer: the row disappears from the front page, and the standby is told. Restart it with the same state home: it is the writer again. Stop all three terminals after testing.

The two checkouts sit at different paths, so moving between them is refused. `test/e2e/cloud-handoff.test.ts` runs the whole handoff (register, join, move, a clean-stop release, a cancelled move) with two faux hosts whose clones share one path through Linux mount namespaces; `test/e2e/cloud-helpers.ts` holds that scaffolding.

## URLs, presence and sync

- `/` is the front page. First one row per project whose writer is connected, with its name and key (`github.com/owner/repo`), the writer and its connected standby machines as quiet chips. When the writer reported a tailnet address, **Open on tailnet** links straight to it (`https://rog.<tailnet>.ts.net:4747`); only tailnet members reach it. Below them, under "Released", a quiet line per project whose lease is free: `boxer · free · last on sentry-mac`, from the directory's `writer.last` (the machine that released it). While that machine is connected and reported a tailnet address, the name links there, where its standby page offers **Resume here**; otherwise there is no link and the line says `offline`. With neither it points to New machine below. The Worker serves the static `dist/front/` shell, which contains no project data, and the page reads `/api/directory` behind Access every 10 seconds. Below the projects, a "Machines" section reads `/api/health` and shows one line per running machine (a project lists it connected, or its machine home reported health within 90 minutes; the report is hourly), then each provider, e.g. `openai-codex ✓ 12m · anthropic ✗ invalid_grant 3h · claude-code ?` (age since the last success, or the last failure with its short error; full text on hover). Offline machines are not shown.
- `/api/directory` and `/api/health` require a verified Cloudflare Access JWT before any Durable Object is touched (RS256, issuer, audience, expiry and not-before); missing config or a failed verification answers a generic 401. Any other `/api` path answers 404 after authentication.
- `/sync/v2?project=<key>` routes to `REPLICA.idFromName(key)`, or to the replica of the key it was relinked to. Any other `/sync` path but snapshots, health, relink and the agent routes below answers 404, so an old sender keeps retrying instead of syncing. Every `/sync` path uses only `Authorization: Bearer <SYNC_TOKEN>` with constant-time comparison.
- Agents (@sync) reach the fleet with the bearer token alone (401 without it). `project=<key>` resolves through relinks exactly as `/sync/v2` does, and the project's replica answers:
  - `GET /sync/directory`: the same JSON as `/api/directory`: per project its key, name, slug (the lowercased repository name, `-2`, `-3`… for collisions), writer `{ machine, online, lastSeen?, tailnet?, last? }` (`last` names the machine that released a free lease), machines `[{ machine, role, connected, lastSeen, tailnet? }]` and the latest transition.
  - `GET /sync/cloud?project=<key>`: `{ machines: [{ machine, role: 'writer' | 'standby', connected, root, lastSeen, tailnet?, missingSecrets }], lease: { machine, epoch, root, online, snapshot? } | null, transition: Transition | null }`. `missingSecrets` are the writer's secret names a standby lacks.
  - `POST /sync/move?project=<key>` `{ machine, force? }`: sends `{ type: 'move-to', id, by: 'sync', force? }` to that machine's standby socket and answers 202 `{ id }`; 409 `{ error: 'not connected' }` without one, `runs there already` for the writer.
  - `POST /sync/cancel?project=<key>`: sends `{ type: 'cancel', id }` to the running transition's target and answers 202 `{ id }`; 409 when nothing can be cancelled or the target is not connected.
- `POST /sync/health` with the bearer token stores a machine's `MachineHealth` (`protocol.ts`; sent by `extensions/health`) in the Directory's `machines (machine TEXT PRIMARY KEY, value TEXT)` table, one row per machine, each report replacing the last. The body may be at most 16 KiB (413 above); a malformed report answers 400: `machine` 1–64 characters, `at` and the provider timestamps numbers, at most 16 providers with names of at most 64 characters and states `ok`, `failing` or `unknown`. Errors are cut to 200 characters and unknown fields are dropped, so only those fields are stored. `GET /sync/health` (bearer) and `GET /api/health` (Access) list every machine's latest report, by name.
- `POST /sync/relink` with `{ key, from }` and the bearer token records in the Directory that `key` syncs to `from`'s replica from now on (a renamed repository keeps its replica and lease). The replica then admits hellos naming either key, its root commit still checked; the relinked key's own row leaves the directory. An alias that would point back at itself is refused.

### Project identity and the writer lease

The key is the checkout's `origin` remote normalised to `github.com/<owner>/<repo>`, lowercased; SSH and HTTPS forms, with or without `.git` or credentials, give the same key, and a worktree reads its main checkout's origin. The repository's oldest root commit travels with it as a sanity check. A project without a GitHub origin does not sync and says so once. Neither the machine nor the path is part of the key.

The replica holds the lease `{ machine, epoch, root }`. The first hello for an unknown key registers its project and makes that machine, at that root, the writer at epoch 1. The writer stores its epoch in `<home>/cloud-lease.json` and names it in each hello; the writer machine without a lease file (after a reinstall) is the writer again and rewrites the file from the `role` it gets. Every other machine, another checkout of the project on the writer machine (another root), and any hello naming another epoch, is a standby, and never replaces the writer's socket: it gets `role: 'standby'` with the writer's machine, root, epoch, online state and secret names, and keeps its socket for updates. A standby's `release` and `release-waiting` are ignored, which fences a stale writer off. A disconnect never moves the lease: an offline writer stays the writer. The writer frees the lease with `release` after uploading a snapshot, keeping epoch and snapshot; a standby then takes it with `claim` at that epoch and becomes the writer at epoch + 1 ("Move here" builds on this). A standby that wants a held lease sends `request-release`; the replica forwards it to the writer's socket as `release-requested { by, id, force? }`, and the writer's `release-waiting { by, tasks, runs?, dirty?, held?, unchecked? }` goes back to that standby's sockets only. `extensions/cloud/README.md` describes the machine side. A hello whose root commit differs from the registered one closes with `PROJECT_MISMATCH` (`4009`, "root commit differs") and the sender stops retrying.

The sync route attaches the URL's key to the socket before accepting it, and hello must repeat it. A malformed hello (a key other than the URL's, an invalid root commit, relative root, port outside 1–65535, epoch, secret list or tailnet address) closes with `PROJECT_MISMATCH` too. Each socket's attachment keeps its machine, role and checkout, so hibernated sockets keep working. A text frame `ping` is answered `pong` by the runtime's WebSocket auto-response, without waking the object; machines use it to notice a half-open socket.

The replica records each machine that says hello, with its root, port, secret names, tailnet address and last-seen time. Secret names and the tailnet address change after hello too: every machine, writer or standby, sends `{ type: 'secrets', secrets, secretsComplete }` (bounded as in hello) and `{ type: 'tailnet', url }` when they change. The replica updates that machine's record, the lease's names when they come from the writer's checkout, and the socket's checkout, then sends every machine its role again, so `missingSecrets` and each standby's `missing` refresh without a reconnect. Accepted hellos, releases, claims, transitions, tailnet changes and socket closes update the Directory row. A project stays listed while a machine holds its lease or a machine is connected; a free project nobody connects to leaves the list. Slug assignments stay reserved, so a returning project keeps its slug. Presence means a connected sync socket.

Replicas once kept a copy of every conversation (`entries`, `docs`, `outbox`, `summaries`, `conversations`, and the machine's system info and models in `metadata`). A replica drops all of that whenever it wakes (`DROP TABLE IF EXISTS`), keeping the project, lease, machines and transition rows of `metadata`. The R2 `ui/` prefix in `ultimate-builds` still holds the retired per-project UI builds; nothing reads them. Deleting them, like any permanent deletion, needs the user's explicit yes, given to @sync.

### Moves and transitions

A machine taking the lease first prepares (see `extensions/cloud/README.md`) and reports each step with `{ type: 'transition', value: Transition | null }`:

```ts
interface Transition {
  id: string
  target: string // the machine taking the lease
  from: string | null // the writer it takes it from; null while the lease is free
  by?: 'local' | 'cloud' | 'sync' | 'auto' // who started it; absent from machines that predate it
  step: 'fetch' | 'install' | 'checks' | 'handover' | 'download' | 'branches' | 'claim' // running now, or the last one
  steps: {
    name: Transition['step'] // in the order they run, as listed above
    state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
    detail?: string // what it did, or why it failed or was skipped
    done?: number // bytes, for download
    total?: number
  }[]
  error?: string // set once it failed or was cancelled; the holder is untouched
  cancellable: boolean // until the claim is sent
  startedAt: number
  left?: string[] // worktrees of the writer's checkout with uncommitted changes the handover waits for, or that stay there on a forced move
  waiting?: string[] // the conversations whose runs the handover waits for, as `#12 title`
}
```

`by` says who started the move: `local` the target's own page ("Move here", "Resume here"), `sync` @sync (its loopback `moveHere { by: 'sync' }` or `/sync/move`), `auto` a starting machine taking a free lease (`cloud.autoClaim`); `cloud` names moves started from the retired cloud UI. The target records it; the replica refuses any other value. The move card's header names it ("Preparing haza-pc · by @sync").

A step may also carry `commits`: the fetch step's fast-forward count. Its detail names it, `main fast-forwarded 2 commits, 3779f5b..34596c0`, or says `main already up to date`.

The replica keeps the latest transition, running or ended, accepting it only from its target's socket, and sends it in `role` (`transition`) to every socket, the writer's too, and in the project's Directory row. While the writer holds a move, its `release-waiting { by, tasks, runs?, dirty?, held?, unchecked? }` sets the handover step's detail to `finishing N runs` and keeps `runs`, the conversations still running, as the transition's `waiting`. Once they drained, the writer names the worktrees of its checkout (the main one included) with uncommitted changes in `dirty`, at most 20 paths of 500 characters each, like `runs`; the replica keeps them as `left`. With `held: true` the writer waits for them (`waiting for 2 worktrees with uncommitted changes`) and an empty `dirty` clears them once committed; a forced move releases at once and they stay there (`2 worktrees with uncommitted changes stay on haza-pc`). `unchecked` (why the writer could not check its worktrees, which holds the move too) is bounded like one path. A failed or cancelled transition ends a writer's drain, and it keeps the project. A missing-secrets failure of `checks` (`error: 'Missing secrets: A, B'`) can be retried with `force`; a missing model login (`No model login: anthropic is not configured here; …`) cannot. Machines bound each `detail` and `error` to 500 characters, keeping the end; the replica refuses longer text.

Every `role` names the replica's own key, `project: { key }`. Snapshots are stored under it and sealed with it as the HKDF salt, on both ends of a move, so a machine connecting with a relinked key finds the snapshots the others wrote.

A transition does not outlive the machines in it. When its target's last socket closes, or the target says hello naming another transition or none (`hello.transition`), the replica ends it as failed with `<target> disconnected`. So does a hello from the writer it waits for, while that writer still holds the lease, that does not name it: a releasing writer reconnects naming the transition, a restarted one does not. A transition whose claim won is never failed this way, even when its reply was lost. The target aborts when the cloud ends its transition, and a draining writer stops and keeps the project.

### Guarantees

- **Only admitted machines write.** With cloud sync on, a home opens storage by itself only when its `cloud-lease.json` names the project: it was the writer. Every other home, new or with a database of its own, waits on standby ("Waiting for the cloud") until the cloud names its role, however long it is unreachable. A writer whose lease file is stale opens offline and is fenced off on reconnect.
- **One authority.** The project's Durable Object is the single authority for who writes: a strongly consistent lease whose epoch changes only by compare-and-swap (`claim` names the epoch it takes over, `release` the one it frees), and the store of the latest transition. Only the lease holder's `release` counts.
- **Inside the writer** Pi Durable's guarantees hold: conversations, entries, tasks and documents are committed to its SQLite storage before anything is shown, and a crash resumes from the last checkpoint. The cloud holds no copy of them.
- **The move** is a state machine of its own. Its durable points are the Durable Object's lease, and on the machines `standby.json` (storage stays closed), `cloud-lease.json` (the epoch held, and the snapshot and hash of the last release) and `cloud-claim.json` (a claim in flight: the epoch claimed, the snapshot, its download and the hash to open). The claim intent is written before `claim` is sent; a machine with one names the claimed epoch + 1 in its hello.
- **What each crash recovers to:**
  - a target crashed while preparing (fetching, installing, checking, waiting for the handover, downloading): its transition fails, the holder keeps the lease, and the restarted target is an ordinary standby. An owed install runs again, and a download without a claim is removed on start.
  - a target crashed after sending `claim`: the restarted target finishes the claim when the cloud names it the writer at the claimed epoch + 1, installing its verified download (fetched again when gone), and otherwise drops the download and the intent and may claim again. A claim whose storage failed to open (parking, installing or opening) keeps both the same way. A claim whose connection dropped is answered by the reconnected hello's role, without a restart.
  - a holder crashed during its release, before `release` reached the cloud: it still holds the lease and resumes as the writer of its own database. After it: the lease is free with the snapshot, and the holder, on standby, resumes with no download since its database is that snapshot.
  - a standby named the writer without an intent opens its own database only when it is the writer's state at that epoch (its lease file's epoch, the last snapshot, or a project it just registered); otherwise it installs the last snapshot first.
- **Logins stay put:** a snapshot holds only the project's database and a bundle of its `ultimate/*` branches. Model provider logins (`~/.pi/agent/auth.json`), `~/.claude`, Secrets and settings never leave the machine; each machine logs in on its own.
- **Never lost:** no step deletes a database; a replaced one is parked as `state.stale-<time>.sqlite`. Every step is safe to run again: fetch only fast-forwards, install is owed from before the fast-forward that changed the lockfile until an install succeeds, downloads are verified before they are renamed into place, branches are never forced, and claims compare and swap.
- **A backup never moves the lease.** "Back up now" (`cloud.backup`) uploads a snapshot like a release does, from the open database, while the writer keeps serving. It sends no `release` or `claim`, leaves the epoch and `cloud-lease.json` as they are, and only the writer may run one, never during a move or release. The writer then sends `backup { at }`, which the replica records for the fleet (`lastBackupAt` in the directory) and nothing else. Backups are snapshots like any other, so the retention under Snapshots covers them: each manifest upload keeps it plus the two newest other complete snapshots of the project.
- **Not guaranteed:** taking the lease from an offline holder. A holder that crashed mid-release and never returns keeps the lease until it does.

### Observability

Workers observability is enabled for persistent invocation logs and traces at full sampling. Query-string redaction is disabled; credentials must remain in Authorization headers, never query strings. The requested `issue_detection` setting is retained, but Wrangler 4.151.1 warns that it is unexpected (the installed schema does not yet support it). `wrangler deploy --dry-run` reports this warning; do not silently discard dashboard settings. `wrangler tail` can miss Durable Object WebSocket events. Sync exceptions log only protocol message type and UTF-8 byte size, never content or exception text. Successful messages are not logged.

## Deploy

Deploys belong to @sync (`agents/sync.md`, "Your Worker"): the lander hands it every landing that touches `cloud/`, `web/` or the dependencies (`lander.deploy` in `.ultimate/settings.json`), and it deploys that commit, verifies routes and telemetry, and rolls back on errors. Ask it whether your Worker is current, or to deploy. Work on the Worker itself (probes, rolling deploys, telemetry) follows the `ultimate-cloud-dev` skill. The one-time setup below stays with the user.

`pnpm cloud:deploy` tags each version with the commit it was built from (`--tag <short sha>`, `-dirty` when `cloud/` has uncommitted changes) and its subject (`--message`). To tell whether the deployed Worker is current: the last entry of `pnpm exec wrangler deployments list --config cloud/wrangler.json --json` names the live `version_id`; `pnpm exec wrangler versions view <id> --config cloud/wrangler.json --json` holds its tag in `annotations["workers/tag"]`; `git diff --quiet <tag> HEAD -- cloud/` succeeds when nothing deployable changed since. A version without a tag, or a `-dirty` one, is unknown until the next deploy.

Durable Object data that no code reaches any more can only be removed with its whole class. Cloudflare refuses to delete a class that the deployed version still binds, so a reset takes two deploys: one moves the binding to a new class while the old one stays exported, the next deletes the old class. Migrations v3 and v4 did this to replace `Replica` with `ProjectReplica`. Migration v5 started the shared-project replicas, `REPLICA` binding `SharedReplica` and `DIRECTORY` binding `ProjectDirectory`, with `ProjectReplica` and `Directory` left exported as stubs; migration v6 deletes those two classes and their data.

The committed config is generic. The domain lives in user settings (`cloud.url`), not the repository. `pnpm cloud:deploy` builds the front page and writes the gitignored `cloud/wrangler.deploy.json`. No credentials belong in the repository or command arguments.

The R2 binding `BUILDS` uses bucket `ultimate-builds`, which holds the move snapshots. In a new account, create it once before deploying:

```sh
pnpm exec wrangler r2 bucket create ultimate-builds
```

The bucket is private; never configure public R2 access. Local `cloud:dev` simulates R2 without contacting the account.

1. In Zero Trust → Access → Applications, protect your hostname with a self-hosted app and your allow policy (for example one-time PIN). Add more-specific apps for `<hostname>/sync` and `<hostname>/sync/*` with a **Bypass** policy (Everyone). Only sync bypasses Access, and it still requires the bearer token.

2. Read the team domain (`<team>.cloudflareaccess.com`) and the app's **Application Audience (AUD) Tag**. The user sets Worker secrets interactively:

   ```sh
   pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN --config cloud/wrangler.json
   pnpm exec wrangler secret put ACCESS_AUD --config cloud/wrangler.json
   pnpm exec wrangler secret put SYNC_TOKEN --config cloud/wrangler.json
   ```

   Team domain is a hostname, without scheme. `SYNC_TOKEN` must match `ULTIMATE_CLOUD_TOKEN` in Ultimate's Secrets panel (⌘K → Secrets). Never print or save secret values. Never set `ACCESS_DEV_BYPASS` in production. Workers.dev and preview URLs remain disabled.

3. Configure `~/.ultimate/settings.json` with `{ "cloud": { "url": "wss://<hostname>", "machine": "my-machine" } }` and run `pnpm cloud:deploy`. The sender connects to `/sync/v2` on that host, whatever path the URL has; `machine` defaults to the OS hostname. Restart hosts after configuring sync. Every further machine joins with [New machine](#new-machine), without a deploy.

For local config validation without touching personal settings, set `ULTIMATE_CLOUD_SETTINGS=/tmp/test-settings.json` (with a placeholder `cloud.url`) and run `pnpm exec node cloud/deploy.ts --dry-run`. The override applies only to the deploy script; generated configs remain gitignored.

### Rolling deploys: test new routes against old objects

A deploy switches the Worker at once, but each Durable Object keeps running the previous code until it restarts. A new Worker→DO call therefore reaches old handlers for a while. `/sync/health` once POSTed to a directory whose old code took every POST as a presence, threw, and two deploys rolled back. Every Worker→DO call a change adds or alters gets a case in `test/cloud-rolling-deploy.test.ts`: freeze the deployed handler's `fetch` (from `git show <deployed sha>:cloud/worker.ts`) as a function over the current store, run the new Worker against it with `againstOld`, and expect a 4xx the caller retries. A 500 means an exception in the old object. Change the request (method or path) until the old code refuses it harmlessly.
