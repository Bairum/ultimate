# Cloud replicas

The Worker serves Ultimate's static UI, a directory, and one SQLite-backed Durable Object replica per machine and project. The agent loop and credentials stay on the machine. `protocol.ts` is the sync contract; `extensions/cloud/` is the sender.

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

After all uploads finish, hello or a `uiBuild` message records the build in the replica and Directory. `/p/<slug>/` serves that build with no-cache, including while the machine is offline. Until an uploaded index is available, it falls back to the generic deploy build. `/p/*` and `/b/*` require the Worker's own Access JWT check: project bundles can contain private source. Assets are private-cacheable and immutable; the generic `ASSETS` files and front page stay public shells.

Its second entry is the front page (`front/`): a small React page with the app's Tailwind theme, styles and UI primitives (`web/src/components/ui`), built to `dist/front/`. Rebuild after changing it; `wrangler dev` picks up the new files.

### Two-instance check

Start two faux hosts in different project directories, using separate temporary state homes and free ports. For each host, from this checkout:

```sh
DEMO_HOME=$(mktemp -d)
ULTIMATE_PROJECT=/absolute/path/to/project ULTIMATE_SUPERVISED=0 ULTIMATE_GENERATION=1 \
  ULTIMATE_FAUX=1 ULTIMATE_HOME="$DEMO_HOME" ULTIMATE_PORT=4801 \
  ULTIMATE_CLOUD_URL=ws://127.0.0.1:8787/sync ULTIMATE_CLOUD_TOKEN=dev \
  ULTIMATE_CLOUD_MACHINE=demo-desk pnpm dev
```

Use port 4802 and a different `DEMO_HOME` and project for the second host. Explicit `ULTIMATE_PROJECT` and supervised mode avoid inheriting the agent terminal's host environment. Never reuse the running host's port or state home.

Create conversations through each local UI (or `POST /api/conversations`, JSON `{}`); submit different prompts. The faux provider answers without model tokens. The cloud front page lists both projects under `demo-desk`. Follow their links and verify each shows only its own conversations. Stop one host: its row becomes offline and its history remains readable. Restart with the same project and state home: its URL stays the same and queued prompts deliver exactly once. Stop all three terminals after testing.

## URLs, presence and sync

- `/` is the front page: machines as sections, each project a row (status, root path, conversation count) linking to its URL. The Worker serves the static `dist/front/` shell, which contains no project data, and the page reads `/api/directory` behind Access every 10 seconds. Rows are links; arrow keys move between them.
- `/p/<machine>/<project>/` serves the SPA. Selecting conversations changes only `?conversation=N`, preserving the project path.
- `/p/<machine>/<project>/api/*` goes to that replica with the prefix removed. Assets stay absolute.
- `/sync?machine=<name>&project=<URL-encoded absolute root>` routes to `REPLICA.idFromName(JSON.stringify([machine, project]))`.

Every Worker response carries `x-ultimate-cloud-version`, the deploy's version ID (plus `:<uiBuild>` on project HTML and API responses) from the `VERSION` (`version_metadata`) binding; WebSocket upgrades are left untouched. The web SDK remembers the first version it sees, and once a later response names another (a deploy happened while the tab was open) it shows one lasting notice, "Ultimate was updated", with **Reload**. A dropped event stream refetches models on reconnect, so even an idle tab notices. An old tab still calling unprefixed `/api/*` gets a 404 with the header too. A local machine sends no header, so nothing changes there. Locally, every `pnpm cloud:dev` start has a new version, so restarting it shows the notice in open tabs.

Every `/api` request, including `/api/directory` and project-prefixed APIs, and all `/p/*` HTML and `/b/*` build assets, require a verified Cloudflare Access JWT before any Durable Object is touched (RS256, issuer, audience, expiry and not-before). Missing config or verification failure returns a generic 401. Unprefixed project APIs return 404 after authentication. `/sync` uses only `Authorization: Bearer <SYNC_TOKEN>` with constant-time comparison.

The sync route binds its replica key before accepting a socket. Hello must match both key fields and the stored project; mismatches close with `PROJECT_MISMATCH` (`4009`), and the sender stops retrying. Hello also carries the local HTTP port (integer 1–65535). The replica records identity and port durably, so hibernated sockets keep working. Accepted hello, socket close, conversation-count changes and the first synced entries update the Directory. Slugs are lowercased URL-safe machine/project basenames, with `-2`, `-3`… for collisions. Running instances always appear. An offline instance with zero synced entries is forgotten; summaries are not the forgetting signal. Slug assignments stay reserved, so a returning project keeps its URL. Presence means a connected sync socket, not tunnel health. Last seen records the last presence update.

On each connection the machine sends a full summary list once, followed by changed summaries and removed IDs. The replica stores them per conversation. Batches are applied atomically and acknowledged; reconnects use entry cursors and document hashes. Retired documents are deleted.

## Live and offline API

With an accepted socket, the replica uses its machine's VPC network binding to reach `http://127.0.0.1:<hello port>`. No binding for that machine means offline-only access. Local development uses `MACHINE_ORIGIN` instead. Requests have loopback Host/Origin and no forwarded/browser admission headers; SSE streams unchanged. Browser Origin and fetch-site checks run before rewriting headers or queuing prompts.

Failed GETs fall back to the synced copy. Failed proxied writes return 502: the machine may have committed them, so check before retrying. Offline events, models and history come from the replica. Text submissions queue in an outbox; UUID request IDs ensure exactly-once admission after reconnect. Negative queue IDs distinguish cloud items. Other offline operations return 503 with `offline: true`; offline cancellation, images, actions, configure, abort and compact are unavailable. Offline UI choices stay tab-local, are not replayed, and disappear on reload. The offline notice appears once per transition. Live task state is omitted. Offline SSE closes when a machine connects, so the browser reconnects through the proxy.

Workers observability is enabled for persistent invocation logs and traces at full sampling. Query-string redaction is disabled; credentials must remain in Authorization headers, never query strings. The requested `issue_detection` setting is retained, but Wrangler 4.151.1 warns that it is unexpected (the installed schema does not yet support it). `wrangler deploy --dry-run` reports this warning; do not silently discard dashboard settings. As with sync, UI upload logs contain only build hashes and file counts, never headers or source. `wrangler tail` can miss Durable Object WebSocket events. Sync exceptions log only protocol message type and UTF-8 byte size, never content or exception text. Successful messages are not logged. A replica that wakes from hibernation with sockets still attached logs `Replica woke: object=<id prefix> sockets=<n> admitted=<n>` in the waking event's trace; it is the only observable sign of eviction. Volatile system info refreshes once a minute, and the sender reconnects after an unacknowledged batch exceeds 60 seconds.

## Deploy

Deploys belong to the standing `@cloudflare` agent (`.ultimate/agents/cloudflare.md`): the lander hands it every landing that touches `cloud/`, `web/` or the dependencies (`lander.deploy` in `.ultimate/settings.json`), and it deploys that commit, verifies routes and telemetry, and rolls back on errors. Ask it for previews and experiments too. The one-time setup below stays with the user.

Durable Object data that no code reaches any more can only be removed with its whole class. Cloudflare refuses to delete a class that the deployed version still binds, so a reset takes two deploys: one moves the binding to a new class while the old one stays exported, the next deletes the old class. Migrations v3 and v4 did this to replace `Replica` with `ProjectReplica`, deleting the replicas left from testing.

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
       "url": "wss://<hostname>/sync",
       "machine": "my-machine",
       "tunnels": { "my-machine": "<tunnel-id>" }
     }
   }
   ```

   `machine` defaults to the OS hostname; tunnel map keys must exactly match the sender's machine name. `cloud.tunnels` replaces `cloud.vpcService`. Deploy generates `TUNNEL_0…n` network bindings and a JSON `TUNNELS` machine-to-binding variable. Restart hosts after configuring sync. Verify login, separate project URLs, live requests, then offline history.

6. To add another machine, create and run its tunnel, add its name and tunnel ID to `cloud.tunnels` on the deploying machine, and deploy again. On the new machine configure the same cloud URL and sync secret, then start Ultimate in any project. No extra binding is needed for additional ports or projects on an existing machine.

For local config validation without touching personal settings, set `ULTIMATE_CLOUD_SETTINGS=/tmp/test-settings.json` and run `pnpm exec node cloud/deploy.ts --dry-run`. Use a dummy tunnel UUID and placeholder hostname in that file. The override applies only to the deploy script; generated configs remain gitignored.
