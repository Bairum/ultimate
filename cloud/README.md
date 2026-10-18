# Cloud replicas

The Worker serves Ultimate's static UI, a directory, and one SQLite-backed Durable Object replica per project. A project is its GitHub repository, so every checkout of it on every machine shares one replica, and exactly one machine, the writer, runs it. The agent loop and credentials stay on the machines. `protocol.ts` is the sync contract; `extensions/cloud/` is the sender.

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

## URLs, presence and sync

- `/` is the front page: one row per project with its writer (`runs on haza-pc`, `haza-pc · offline since 3h ago`, or `free`), its standby machines as quiet chips, its key and conversation count, linking to its URL. The Worker serves the static `dist/front/` shell, which contains no project data, and the page reads `/api/directory` behind Access every 10 seconds. Rows are links; arrow keys move between them.
- `/p/<slug>/` serves the SPA. Selecting conversations changes only `?conversation=N`, preserving the project path.
- `/p/<slug>/api/*` goes to that project's replica with the prefix removed: proxied to the writer while it is online, from the synced copy otherwise. Assets stay absolute.
- `/p/<machine>/<name>/…`, the URLs from before projects were shared, answer 308 to `/p/<name>/…` when `<machine>` is no project slug and `<name>` is one.
- `/sync/v2?project=<key>` routes to `REPLICA.idFromName(key)`. Any other `/sync` path but builds and snapshots answers 404, so an old sender keeps retrying instead of syncing.

### Project identity and the writer lease

The key is the checkout's `origin` remote normalised to `github.com/<owner>/<repo>`, lowercased; SSH and HTTPS forms, with or without `.git` or credentials, give the same key, and a worktree reads its main checkout's origin. The repository's oldest root commit travels with it as a sanity check. A project without a GitHub origin does not sync and says so once. Neither the machine nor the path is part of the key.

The replica holds the lease `{ machine, epoch }`. The first hello for an unknown key registers its project and makes that machine the writer at epoch 1. The writer stores its epoch in `<home>/cloud-lease.json` and names it in each hello; the writer machine without a lease file (after a reinstall) is the writer again and rewrites the file from the `role` it gets. Every other machine, and any hello naming another epoch, is a standby: it gets `role: 'standby'` with the writer's machine, root, epoch, online state and secret names, keeps its socket for updates, and sends nothing else. Anything but hello and claim from a standby socket is ignored, which fences a stale writer off. A disconnect never moves the lease: an offline writer stays the writer. The writer frees the lease with `release` after uploading a snapshot, keeping epoch and snapshot; a standby then takes it with `claim` at that epoch and becomes the writer at epoch + 1 ("Move here" builds on this). A hello whose root commit differs from the registered one closes with `PROJECT_MISMATCH` (`4009`, "root commit differs") and the sender stops retrying.

The replica records each machine that says hello, with its root, port, secret names and last-seen time. Accepted hellos, releases, claims, socket closes, conversation-count changes and the first synced entries update the Directory: per project its key, name, slug, writer `{ machine, online, lastSeen }`, machines `[{ machine, role, connected, lastSeen }]`, conversation count and UI build. Slugs are the lowercased repository name (`ultimate`, `poe2-rust`), with `-2`, `-3`… for collisions. Projects with a connected machine always appear. An offline project with zero synced entries is forgotten; summaries are not the forgetting signal. Slug assignments stay reserved, so a returning project keeps its URL. Presence means a connected sync socket, not tunnel health.

Every Worker response carries `x-ultimate-cloud-version`, the deploy's version ID (plus `:<uiBuild>` on project HTML and API responses) from the `VERSION` (`version_metadata`) binding; WebSocket upgrades are left untouched. The web SDK remembers the first version it sees, and once a later response names another (a deploy happened while the tab was open) it shows one lasting notice, "Ultimate was updated", with **Reload**. A dropped event stream refetches models on reconnect, so even an idle tab notices. An old tab still calling unprefixed `/api/*` gets a 404 with the header too. A local machine sends no header, so nothing changes there. Locally, every `pnpm cloud:dev` start has a new version, so restarting it shows the notice in open tabs.

Every `/api` request, including `/api/directory` and project-prefixed APIs, and all `/p/*` HTML and `/b/*` build assets, require a verified Cloudflare Access JWT before any Durable Object is touched (RS256, issuer, audience, expiry and not-before). Missing config or verification failure returns a generic 401. Unprefixed project APIs return 404 after authentication. `/sync` uses only `Authorization: Bearer <SYNC_TOKEN>` with constant-time comparison.

The sync route attaches the URL's key to the socket before accepting it, and hello must repeat it. A malformed hello (a key other than the URL's, an invalid root commit, relative root, port outside 1–65535, epoch or secret list) closes with `PROJECT_MISMATCH` too. Each socket's attachment keeps its machine and role, so hibernated sockets keep working.

On each connection the writer sends a full summary list once, followed by changed summaries and removed IDs. The replica stores them per conversation. Batches are applied atomically and acknowledged; reconnects use entry cursors and document hashes. Retired documents are deleted.

## Live and offline API

With a writer socket open, the replica uses the writer machine's VPC network binding to reach `http://127.0.0.1:<hello port>`. No binding for that machine means offline-only access. Local development uses `MACHINE_ORIGIN` instead. Requests have loopback Host/Origin and no forwarded/browser admission headers; SSE streams unchanged. Browser Origin and fetch-site checks run before rewriting headers or queuing prompts.

Failed GETs fall back to the synced copy. Failed proxied writes return 502: the machine may have committed them, so check before retrying. Offline events, models and history come from the replica. Text submissions queue in an outbox; UUID request IDs ensure exactly-once admission after reconnect. Negative queue IDs distinguish cloud items. Other offline operations return 503 with `offline: true`; offline cancellation, images, actions, configure, abort and compact are unavailable. Offline UI choices stay tab-local, are not replayed, and disappear on reload. The offline notice appears once per transition. Live task state is omitted. Offline SSE closes when a machine connects, so the browser reconnects through the proxy.

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
