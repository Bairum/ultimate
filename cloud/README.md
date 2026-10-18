# Cloud replicas

The Worker serves Ultimate's static UI, a directory, and one SQLite-backed Durable Object replica per project. A project is its GitHub repository, so every checkout of it on every machine shares one replica, and exactly one machine, the writer, runs it. The agent loop and credentials stay on the machines. `protocol.ts` is the sync contract; `extensions/cloud/` is the sender.

## New machine

To add a machine to the projects a deployed cloud already holds (see [Deploy](#deploy) for the first one):

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
   - [ ] Set `cloud.url` and `cloud.machine` in `~/.ultimate/settings.json` (step 5 of [Deploy](#deploy)).
   - [ ] Create the machine's tunnel (`pnpm exec wrangler tunnel create ultimate-<machine>` from any logged-in
         machine), add it to `cloud.tunnels` on the deploying machine, and deploy again (step 6 of
         [Deploy](#deploy)). Without it the project shows in the cloud only read-only, as if offline, while that
         machine runs it.
   - [ ] Run `pnpm setup:machine` in the clone (Linux; `--dry-run` shows the units and commands first). It installs and
         enables the user units `ultimate.service` (`--project <dir>`, default the clone),
         `ultimate-tunnel.service` (Wrangler must be logged in on this machine; skipped until `cloud.tunnels` has
         the machine) and `ultimate-machine.service` (the machine home on port 4700), and enables linger so all
         three start at boot without a login. Run it again after changing node.
3. Run `ultimate` in a checkout at the same path as on the other machines (a move to a checkout at another path is
   refused). Where the project ends up depends on the checkout's `origin`:
   - **A GitHub origin the cloud knows:** the machine joins as a standby. Until the cloud answers it waits on standby
     ("Waiting for the cloud") without opening any database, however long the cloud is unreachable; only the
     machine whose `cloud-lease.json` names the project, its last writer, opens storage offline. A database already in
     the home stays in place, untouched.
   - **A GitHub origin the cloud does not know:** the project is registered with this machine as its writer, with its
     existing database if it has one, otherwise a fresh state.
   - **No GitHub origin:** the project stays local only; the status line says `local only`.
4. Move a project with **Move here** on a standby's page or in the status line's `on <machine>` popover, or pick the
   machine under **Run on…** in the cloud: the project page's status line, its offline banner, or a row of the front
   page. The machine fast-forwards its checkout, installs when the lockfile changed, checks its model login and secrets, has the writer
   finish its running tasks and release, downloads the snapshot and takes over; every step shows in the move's card on
   both machines and in the cloud. An idle writer releases the project by itself after `cloud.idleRelease` minutes
   (default 10) and when Ultimate stops, so the next machine takes it without waiting for the first; **Resume here**
   takes it back.

## Run locally

No Cloudflare account is needed:

```sh
pnpm install
pnpm cloud:build
```

Create `cloud/.dev.vars` (gitignored):

```dotenv
SYNC_TOKEN=dev
MACHINE_ORIGIN=http://127.0.0.1
ACCESS_DEV_BYPASS=1
```

`ACCESS_DEV_BYPASS=1` explicitly skips JWT verification for local development. Keep it in `.dev.vars`, which Wrangler does not deploy; never set it on the deployed Worker. `MACHINE_ORIGIN` supplies the local hostname; the accepted hello supplies each instance's port. No production tunnel is contacted.

Run `pnpm cloud:dev` and open the printed URL (normally http://localhost:8787). Local Durable Object data persists in `cloud/.wrangler/`. Replicas are derived, disposable data: after a schema change delete `cloud/.wrangler/` and sync again; there are no replica schema migrations.

Each connected machine builds its project's UI in a production-mode child process (`nice -n 10`), using the same trusted, enabled extension discovery as its local host. Vite never runs in the agent's event loop. An initial build runs on connect; changes to `web/`, enabled facet directories, shared contracts or build configuration start a 60-second quiet period. Builds never overlap within an instance. The fingerprint and successful build are cached in the instance's state home. Reconnects check the cached build for missing cloud files.

Uploads use the sync bearer token in the Authorization header (never in URLs), over HTTPS except loopback development. `POST /sync/builds/<uiBuild>` accepts a file manifest and returns missing names; `PUT /sync/builds/<uiBuild>/<name>` uploads only those files. The Worker authenticates before touching R2. Limits are 16 MiB per file, 128 MiB per manifest and 1,024 files; PUT sizes must match the manifest. Paths are restricted to `index.html` and flat `assets/` names under a fixed `ui/` R2 prefix. The index content must hash to its build ID.

`uiBuild` is the first 12 hex digits of the SHA-256 of `index.html`. To avoid a circular hash/base dependency, builds use the fixed `/b/shared/` base: Vite's content-hashed asset names are unique URLs and deduplicate across builds at `ui/assets/*`. Each index is kept at `ui/builds/<uiBuild>/index.html`. `/b/<uiBuild>/` keeps old HTML addressable; `/b/<uiBuild>/assets/*` also serves the shared hashed assets. **No garbage collection yet.**

Snapshots carry a project's database and branches from one machine to the next (`snapshots.ts`, written by `extensions/cloud/snapshot.ts`). `PUT` and `GET /sync/snapshots/<sha256(project key) hex>/<id>/<name>` store and read opaque objects under `snapshots/` in the same private bucket, with the same bearer token. `<id>` matches `^[a-z0-9-]{8,64}$`, `<name>` is `manifest`, `db-<n>` or `bundle-<n>`, and a body may be at most 17 MiB (413 above). The machine compresses and encrypts every object, the manifest included, so R2 holds only ciphertext and the Worker logs nothing about them. A manifest upload completes a snapshot and prunes the project's prefix: the snapshot just uploaded and the two newest other complete ones stay, older complete ones and partial uploads idle for an hour are deleted.

After all uploads finish, the writer's hello or `uiBuild` message records the build in the replica and Directory. `/p/<slug>/` serves that build with no-cache, including while the machine is offline. Until an uploaded index is available, it falls back to the generic deploy build. `/p/*` and `/b/*` require the Worker's own Access JWT check: project bundles can contain private source. Assets are private-cacheable and immutable; the generic `ASSETS` files and front page stay public shells.

Its second entry is the front page (`front/`): a small React page with the app's Tailwind theme, styles and UI primitives (`web/src/components/ui`), built to `dist/front/`. Rebuild after changing it; `wrangler dev` picks up the new files.

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

The first host to connect registers the project and becomes its writer (`cloud-lease.json` appears in its home); the second is a standby. The front page shows one row, `demo-project`, running on `demo-desk` with `demo-laptop` as a standby chip. Start coordinator branches through @ultimate in the writer's local UI and submit prompts; the faux provider answers without model tokens, and `/p/demo-project/` shows them. Nothing from the standby reaches the replica. Stop the writer: the row says `demo-desk · offline since …`, its history stays readable, and the standby is told. Restart it with the same state home: it is the writer again, and queued prompts deliver exactly once. Stop all three terminals after testing.

The two checkouts sit at different paths, so moving between them is refused. `test/e2e/cloud-handoff.test.ts` runs the whole handoff (register, join, move, idle release, a cancelled move) with two faux hosts whose clones share one path through Linux mount namespaces; `test/e2e/cloud-helpers.ts` holds that scaffolding.

## URLs, presence and sync

- `/` is the front page: one row per project with its writer (`runs on haza-pc`, `haza-pc · offline since 3h ago`, or `free`), its standby machines as quiet chips, its key and conversation count, linking to its URL. While the writer is online and reported a tailnet address, **Open on tailnet** links straight to it (`https://rog.<tailnet>.ts.net:4747`), skipping the cloud; only tailnet members reach it. The Worker serves the static `dist/front/` shell, which contains no project data, and the page reads `/api/directory` behind Access every 10 seconds. Rows are links; arrow keys move between them. Below the projects, a "Machines" section reads `/api/health` and shows one line per machine that reported its provider health: an online dot (a project lists it connected, or it reported within 2 h), then each provider, e.g. `openai-codex ✓ 12m · anthropic ✗ invalid_grant 3h · claude-code ?` (age since the last success, or the last failure with its short error; full text on hover), and `reported 3h ago` once a report is older than 90 minutes.
- `/p/<slug>/` serves the SPA. Selecting conversations changes only `?conversation=N`, preserving the project path.
- `/p/<slug>/api/*` goes to that project's replica with the prefix removed: proxied to the writer while it is online, from the synced copy otherwise. Assets stay absolute.
- `/p/<machine>/<name>/…`, the URLs from before projects were shared, answer 308 to `/p/<name>/…` when `<machine>` is no project slug and `<name>` is one.
- `/sync/v2?project=<key>` routes to `REPLICA.idFromName(key)`, or to the replica of the key it was relinked to. Any other `/sync` path but builds, snapshots, relink and the agent routes below answers 404, so an old sender keeps retrying instead of syncing.
- Agents, which cannot pass Access, reach the cloud UI's routes with `Authorization: Bearer <SYNC_TOKEN>` alone (401 without it). `project=<key>` resolves through relinks exactly as `/sync/v2` does, and the project's replica answers with its own handlers:
  - `GET /sync/directory`: the same JSON as `/api/directory`.
  - `GET /sync/cloud?project=<key>`: the same as the project's `GET /api/cloud`.
  - `POST /sync/move?project=<key>` `{ machine, force? }`: the same as `POST /api/cloud/move` (202 `{ id }`, 409 `{ error }`), but the move is recorded as started by @sync (`by: 'sync'`). The Worker sends it to the replica's own `/sync/move` path, which no browser request reaches.
  - `POST /sync/cancel?project=<key>`: the same as `POST /api/cloud/cancel`.
- `POST /sync/health` with the bearer token stores a machine's `MachineHealth` (`protocol.ts`; sent by `extensions/health`) in the Directory's `machines (machine TEXT PRIMARY KEY, value TEXT)` table, one row per machine, each report replacing the last. The body may be at most 16 KiB (413 above); a malformed report answers 400: `machine` 1–64 characters, `at` and the provider timestamps numbers, at most 16 providers with names of at most 64 characters and states `ok`, `failing` or `unknown`. Errors are cut to 200 characters and unknown fields are dropped, so only those fields are stored. `GET /sync/health` (bearer) and `GET /api/health` (Access) list every machine's latest report, by name.
- `POST /sync/relink` with `{ key, from }` and the bearer token records in the Directory that `key` syncs to `from`'s replica from now on (a renamed repository keeps its replica and lease). The replica then admits hellos naming either key, its root commit still checked; the relinked key's own row leaves the directory. An alias that would point back at itself is refused.

### Project identity and the writer lease

The key is the checkout's `origin` remote normalised to `github.com/<owner>/<repo>`, lowercased; SSH and HTTPS forms, with or without `.git` or credentials, give the same key, and a worktree reads its main checkout's origin. The repository's oldest root commit travels with it as a sanity check. A project without a GitHub origin does not sync and says so once. Neither the machine nor the path is part of the key.

The replica holds the lease `{ machine, epoch, root }`. The first hello for an unknown key registers its project and makes that machine, at that root, the writer at epoch 1. The writer stores its epoch in `<home>/cloud-lease.json` and names it in each hello; the writer machine without a lease file (after a reinstall) is the writer again and rewrites the file from the `role` it gets. Every other machine, another checkout of the project on the writer machine (another root), and any hello naming another epoch, is a standby, and never replaces the writer's socket: it gets `role: 'standby'` with the writer's machine, root, epoch, online state and secret names, keeps its socket for updates, and sends nothing else but `claim`, `request-release`, `transition` and `secrets`. Any data from a standby socket is ignored, which fences a stale writer off. A disconnect never moves the lease: an offline writer stays the writer. The writer frees the lease with `release` after uploading a snapshot, keeping epoch and snapshot; a standby then takes it with `claim` at that epoch and becomes the writer at epoch + 1 ("Move here" builds on this). A standby that wants a held lease sends `request-release`; the replica forwards it to the writer's socket as `release-requested { by, id, force? }`, and the writer's `release-waiting { by, tasks, runs?, dirty?, held?, unchecked? }` goes back to that standby's sockets only. `extensions/cloud/README.md` describes the machine side. A hello whose root commit differs from the registered one closes with `PROJECT_MISMATCH` (`4009`, "root commit differs") and the sender stops retrying.

The replica records each machine that says hello, with its root, port, secret names and last-seen time. Secret names change after hello too: every machine, writer or standby, sends `{ type: 'secrets', secrets, secretsComplete }` (bounded as in hello) when the user's names change. The replica updates that machine's record, the lease's names when it comes from the writer's checkout, and the socket's checkout, then sends every machine its role again, so `missingSecrets` and each standby's `missing` refresh without a reconnect. Accepted hellos, releases, claims, socket closes, conversation-count changes and the first synced entries update the Directory: per project its key, name, slug, writer `{ machine, online, lastSeen }`, machines `[{ machine, role, connected, lastSeen }]`, conversation count and UI build. Slugs are the lowercased repository name (`ultimate`, `poe2-rust`), with `-2`, `-3`… for collisions. Projects with a connected machine always appear. An offline project with zero synced entries is forgotten; summaries are not the forgetting signal. Slug assignments stay reserved, so a returning project keeps its URL. Presence means a connected sync socket, not tunnel health.

Every Worker response carries `x-ultimate-cloud-version`, the deploy's version ID (plus `:<uiBuild>` on project HTML and API responses) from the `VERSION` (`version_metadata`) binding; WebSocket upgrades are left untouched. The web SDK remembers the first version it sees, and once a later response names another (a deploy happened while the tab was open) it shows one lasting notice, "Ultimate was updated", with **Reload**. A dropped event stream refetches models on reconnect, so even an idle tab notices. An old tab still calling unprefixed `/api/*` gets a 404 with the header too. A local machine sends no header, so nothing changes there. Locally, every `pnpm cloud:dev` start has a new version, so restarting it shows the notice in open tabs.

Every `/api` request, including `/api/directory` and project-prefixed APIs, and all `/p/*` HTML and `/b/*` build assets, require a verified Cloudflare Access JWT before any Durable Object is touched (RS256, issuer, audience, expiry and not-before). Missing config or verification failure returns a generic 401. Unprefixed project APIs return 404 after authentication. `/sync` uses only `Authorization: Bearer <SYNC_TOKEN>` with constant-time comparison.

The sync route attaches the URL's key to the socket before accepting it, and hello must repeat it. A malformed hello (a key other than the URL's, an invalid root commit, relative root, port outside 1–65535, epoch or secret list) closes with `PROJECT_MISMATCH` too. Each socket's attachment keeps its machine and role, so hibernated sockets keep working.

On each connection the writer sends a full summary list once, followed by changed summaries and removed IDs. The replica stores them per conversation. Batches are applied atomically and acknowledged; reconnects use entry cursors and document hashes. Retired documents are deleted.

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

`by` says who started the move: `local` the target's own page ("Move here", "Resume here"), `cloud` the cloud UI or front page behind Access, `sync` @sync (its loopback `moveHere { by: 'sync' }` or `/sync/move`), `auto` a starting machine taking a free lease (`cloud.autoClaim`). The target records it; the replica refuses any other value. The move card's header names it ("Preparing haza-pc · started from the cloud UI").

A step may also carry `commits`: the fetch step's fast-forward count. Its detail names it, `main fast-forwarded 2 commits, 3779f5b..34596c0`, or says `main already up to date`.

The replica keeps the latest transition, running or ended, accepting it only from its target's socket, and sends it in `role` (`transition`) to every socket, the writer's too, and in the project's Directory row. While the writer holds a move, its `release-waiting { by, tasks, runs?, dirty?, held?, unchecked? }` sets the handover step's detail to `finishing N runs` and keeps `runs`, the conversations still running, as the transition's `waiting`. Once they drained, the writer names the worktrees of its checkout (the main one included) with uncommitted changes in `dirty`, at most 20 paths of 500 characters each, like `runs`; the replica keeps them as `left`. With `held: true` the writer waits for them (`waiting for 2 worktrees with uncommitted changes`) and an empty `dirty` clears them once committed; a forced move releases at once and they stay there (`2 worktrees with uncommitted changes stay on haza-pc`). `unchecked` (why the writer could not check its worktrees, which holds the move too) is bounded like one path. `runs`, `held`, `unchecked`, `waiting` and `force` are optional: writers and Workers that predate them omit them. A failed or cancelled transition ends a writer's drain, and it keeps the project. A missing-secrets failure of `checks` (`error: 'Missing secrets: A, B'`) can be retried with `force`; a missing model login (`No model login: anthropic is not configured here; …`) cannot. Machines bound each `detail` and `error` to 500 characters, keeping the end; the replica refuses longer text.

Every `role` names the replica's own key, `project: { key }`. Snapshots are stored under it and sealed with it as the HKDF salt, on both ends of a move, so a machine connecting with a relinked key finds the snapshots the others wrote.

A transition does not outlive the machines in it. When its target's last socket closes, or the target says hello naming another transition or none (`hello.transition`), the replica ends it as failed with `<target> disconnected`. So does a hello from the writer it waits for, while that writer still holds the lease, that does not name it: a releasing writer reconnects naming the transition, a restarted one does not. A transition whose claim won is never failed this way, even when its reply was lost. The target aborts when the cloud ends its transition, and a draining writer stops and keeps the project.

The project API answers three routes itself, before any request goes to the machine, behind the same Access check as every `/p/*` path:

- `GET /api/cloud`: `{ machines: [{ machine, role: 'writer' | 'standby', connected, root, lastSeen, missingSecrets }], lease: { machine, epoch, root, online, snapshot? } | null, transition: Transition | null }`. `missingSecrets` are the writer's secret names a standby lacks.
- `POST /api/cloud/move { machine, force? }`: sends `{ type: 'move-to', id, by: 'cloud', force? }` (`by: 'sync'` from `/sync/move`) to that machine's standby socket and answers 202 `{ id }`; 409 `{ error: 'not connected' }` without one, `runs there already` for the writer.
- `POST /api/cloud/cancel`: sends `{ type: 'cancel', id }` to the running transition's target and answers 202 `{ id }`; 409 when nothing can be cancelled or the target is not connected.

### Guarantees

- **Only admitted machines write.** With cloud sync on, a home opens storage by itself only when its `cloud-lease.json` names the project: it was the writer. Every other home, new or with a database of its own, waits on standby ("Waiting for the cloud") until the cloud names its role, however long it is unreachable. A writer whose lease file is stale opens offline and is fenced off on reconnect.
- **One authority.** The project's Durable Object is the single authority for who writes: a strongly consistent lease whose epoch changes only by compare-and-swap (`claim` names the epoch it takes over, `release` the one it frees), and the store of the latest transition. Only the lease holder's data is applied.
- **Inside the writer** Pi Durable's guarantees hold: conversations, entries, tasks and documents are committed to its SQLite storage before anything is shown, and a crash resumes from the last checkpoint.
- **The move** is a state machine of its own. Its durable points are the Durable Object's lease, and on the machines `standby.json` (storage stays closed), `cloud-lease.json` (the epoch held, and the snapshot and hash of the last release) and `cloud-claim.json` (a claim in flight: the epoch claimed, the snapshot, its download and the hash to open). The claim intent is written before `claim` is sent; a machine with one names the claimed epoch + 1 in its hello.
- **What each crash recovers to:**
  - a target crashed while preparing (fetching, installing, checking, waiting for the handover, downloading): its transition fails, the holder keeps the lease, and the restarted target is an ordinary standby. An owed install runs again, and a download without a claim is removed on start.
  - a target crashed after sending `claim`: the restarted target finishes the claim when the cloud names it the writer at the claimed epoch + 1, installing its verified download (fetched again when gone), and otherwise drops the download and the intent and may claim again. A claim whose storage failed to open (parking, installing or opening) keeps both the same way. A claim whose connection dropped is answered by the reconnected hello's role, without a restart.
  - a holder crashed during its release, before `release` reached the cloud: it still holds the lease and resumes as the writer of its own database. After it: the lease is free with the snapshot, and the holder, on standby, resumes with no download since its database is that snapshot.
  - a standby named the writer without an intent opens its own database only when it is the writer's state at that epoch (its lease file's epoch, the last snapshot, or a project it just registered); otherwise it installs the last snapshot first.
- **Logins stay put:** a snapshot holds only the project's database and a bundle of its `ultimate/*` branches. Model provider logins (`~/.pi/agent/auth.json`), `~/.claude`, Secrets and settings never leave the machine; each machine logs in on its own.
- **Never lost:** no step deletes a database; a replaced one is parked as `state.stale-<time>.sqlite`. Every step is safe to run again: fetch only fast-forwards, install is owed from before the fast-forward that changed the lockfile until an install succeeds, downloads are verified before they are renamed into place, branches are never forced, and claims compare and swap.
- **Not guaranteed:** taking the lease from an offline holder. A holder that crashed mid-release and never returns keeps the lease until it does.

## Live and offline API

With a writer socket open, the replica uses the writer machine's VPC network binding to reach `http://127.0.0.1:<hello port>`. No binding for that machine means offline-only access. Local development uses `MACHINE_ORIGIN` instead. Requests have loopback Host/Origin and no forwarded/browser admission headers; SSE streams unchanged. Browser Origin and fetch-site checks run before rewriting headers or queuing prompts.

Failed GETs fall back to the synced copy. Failed proxied writes return 502: the machine may have committed them, so check before retrying. A deploy restarts the replica and closes every sync socket; a machine whose connection had been open for 10 seconds reconnects at once, and only from its second failed attempt on with backoff, so the 503 offline window after a deploy stays short. Offline events, models and history come from the replica. Text submissions queue in an outbox; UUID request IDs ensure exactly-once admission after reconnect. Negative queue IDs distinguish cloud items. Other offline operations return 503 with `offline: true`; offline cancellation, images, actions, configure, abort and compact are unavailable. Offline UI choices stay tab-local, are not replayed, and disappear on reload. The offline notice appears once per transition. Live task state is omitted. Offline SSE closes when a machine connects, so the browser reconnects through the proxy.

Workers observability is enabled for persistent invocation logs and traces at full sampling. Query-string redaction is disabled; credentials must remain in Authorization headers, never query strings. The requested `issue_detection` setting is retained, but Wrangler 4.151.1 warns that it is unexpected (the installed schema does not yet support it). `wrangler deploy --dry-run` reports this warning; do not silently discard dashboard settings. As with sync, UI upload logs contain only build hashes and file counts, never headers or source. `wrangler tail` can miss Durable Object WebSocket events. Sync exceptions log only protocol message type and UTF-8 byte size, never content or exception text. Successful messages are not logged. A replica that wakes from hibernation with sockets still attached logs `Replica woke: object=<id prefix> sockets=<n> admitted=<n>` in the waking event's trace; it is the only observable sign of eviction. Volatile system info refreshes once a minute, and the sender reconnects after an unacknowledged batch exceeds 60 seconds.

## Deploy

Deploys belong to the standing `@cloudflare` agent (`.ultimate/agents/cloudflare.md`): the lander hands it every landing that touches `cloud/`, `web/` or the dependencies (`lander.deploy` in `.ultimate/settings.json`), and it deploys that commit, verifies routes and telemetry, and rolls back on errors. Ask it for previews and experiments too. The one-time setup below stays with the user.

Durable Object data that no code reaches any more can only be removed with its whole class. Cloudflare refuses to delete a class that the deployed version still binds, so a reset takes two deploys: one moves the binding to a new class while the old one stays exported, the next deletes the old class. Migrations v3 and v4 did this to replace `Replica` with `ProjectReplica`, deleting the replicas left from testing. Migration v5 starts the shared-project replicas: `REPLICA` binds `SharedReplica` and `DIRECTORY` binds `ProjectDirectory`, while `ProjectReplica` and `Directory` stay exported as stubs answering 410 until a follow-up deploy deletes them. Every machine re-syncs into the new classes.

The committed config is generic. Domains and tunnel IDs live in user settings, not the repository. `pnpm cloud:deploy` builds the UI and front page and writes the gitignored `cloud/wrangler.deploy.json`. No credentials belong in the repository or command arguments. Open tabs keep working across a deploy: they offer a reload once they see the new version.

The R2 binding `BUILDS` uses bucket `ultimate-builds`. In a new account, create it once before deploying:

```sh
pnpm exec wrangler r2 bucket create ultimate-builds
```

The bucket is private; never configure public R2 access for project builds. Local `cloud:dev` simulates R2 without contacting the account. Add the Access Bypass application for `/sync/*` as well as `/sync` so bearer-authenticated build uploads reach the Worker without the interactive PIN login. Access must still protect `/p/*` and `/b/*`; the Worker verifies those JWTs independently.

1. With Wrangler logged in, create one remotely managed tunnel per machine:

   ```sh
   pnpm exec wrangler tunnel create ultimate-<machine>
   ```

   No per-port VPC service is needed. A VPC **network** binding routes through this tunnel to each instance's loopback port. See [Workers VPC](https://developers.cloudflare.com/workers-vpc/).

2. Run the tunnel in the user's session. Install cloudflared and create `~/.config/systemd/user/ultimate-tunnel.service`, using absolute paths:

   ```ini
   [Unit]
   Description=Ultimate Cloudflare tunnel
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   WorkingDirectory=/absolute/path/to/ultimate
   ExecStart=/absolute/path/to/pnpm exec wrangler tunnel run ultimate-<machine>
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now ultimate-tunnel.service
   ```

   Wrangler fetches the tunnel credential through its authenticated API; do not extract or paste a token. The unit stops with the user session unless linger is enabled.

3. In Zero Trust → Access → Applications, protect your hostname with a self-hosted app and your allow policy (for example one-time PIN). Add a more-specific app for `<hostname>/sync` with a **Bypass** policy (Everyone). Only sync bypasses Access, and it still requires the bearer token.

4. Read the team domain (`<team>.cloudflareaccess.com`) and the app's **Application Audience (AUD) Tag**. The user sets Worker secrets interactively:

   ```sh
   pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN --config cloud/wrangler.json
   pnpm exec wrangler secret put ACCESS_AUD --config cloud/wrangler.json
   pnpm exec wrangler secret put SYNC_TOKEN --config cloud/wrangler.json
   ```

   Team domain is a hostname, without scheme. `SYNC_TOKEN` must match `ULTIMATE_CLOUD_TOKEN` in Ultimate's Secrets panel (⌘K → Secrets). Never print or save secret values. Never set `ACCESS_DEV_BYPASS` in production. Workers.dev and preview URLs remain disabled.

5. Configure `~/.ultimate/settings.json`:

   ```json
   {
     "cloud": {
       "url": "wss://<hostname>",
       "machine": "my-machine",
       "tunnels": { "my-machine": "<tunnel-id>" }
     }
   }
   ```

   The sender connects to `/sync/v2` on that host, whatever path the URL has. `machine` defaults to the OS hostname; tunnel map keys must exactly match the sender's machine name. `cloud.tunnels` replaces `cloud.vpcService`. Deploy generates `TUNNEL_0…n` network bindings and a JSON `TUNNELS` machine-to-binding variable. Restart hosts after configuring sync. Verify login, separate project URLs, live requests, then offline history.

6. To add another machine, create and run its tunnel, add its name and tunnel ID to `cloud.tunnels` on the deploying machine, and deploy again. On the new machine configure the same cloud URL and sync secret, then start Ultimate in a checkout. A project the cloud already knows connects as a standby; an unknown one registers with this machine as its writer. No extra binding is needed for additional ports or projects on an existing machine.

For local config validation without touching personal settings, set `ULTIMATE_CLOUD_SETTINGS=/tmp/test-settings.json` and run `pnpm exec node cloud/deploy.ts --dry-run`. Use a dummy tunnel UUID and placeholder hostname in that file. The override applies only to the deploy script; generated configs remain gitignored.

### Rolling deploys: test new routes against old objects

A deploy switches the Worker at once, but each Durable Object keeps running the previous code until it restarts. A new Worker→DO call therefore reaches old handlers for a while. `/sync/health` once POSTed to a directory whose old code took every POST as a presence, threw, and two deploys rolled back. Every Worker→DO call a change adds or alters gets a case in `test/cloud-rolling-deploy.test.ts`: freeze the deployed handler's `fetch` (from `git show <deployed sha>:cloud/worker.ts`) as a function over the current store, run the new Worker against it with `againstOld`, and expect a 4xx the caller retries. A 500 means an exception in the old object. Change the request (method or path) until the old code refuses it harmlessly.
