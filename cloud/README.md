# Cloud replica spike

The Worker serves a static Ultimate UI and a SQLite-backed Durable Object replica for one machine. The agent loop and credentials stay on the machine. `protocol.ts` is the sync contract; `extensions/cloud/` is the machine-side sender.

## Run locally

No Cloudflare account is needed:

```sh
pnpm install
pnpm cloud:build
```

Create `cloud/.dev.vars` (gitignored):

```dotenv
SYNC_TOKEN=dev
MACHINE_ORIGIN=http://127.0.0.1:4800
ACCESS_DEV_BYPASS=1
```

`ACCESS_DEV_BYPASS=1` explicitly skips JWT verification only for local development. Keep it in `.dev.vars`, which Wrangler does not deploy; never set it on the deployed Worker. The committed `wrangler.json` has no VPC binding, so `cloud:dev` reaches the local host through `MACHINE_ORIGIN` without contacting a private production service.

Then run `pnpm cloud:dev` and open the URL Wrangler prints (normally http://localhost:8787). Local Durable Object data persists in `cloud/.wrangler/`. Stop with Ctrl+C.
The replica is derived from the machine, and its schema is not migrated: after pulling a replica schema change, delete `cloud/.wrangler/` and let the machine sync again.

The build includes the web facets discovered by Ultimate's extension loader. This is a production build, not the machine's Vite dev server. Rebuild after changing facets.

## Try it locally

Build and start Wrangler as above, using port 4800 for `MACHINE_ORIGIN`. In another terminal, start a token-free machine with a temporary state home (keep the printed path for the restart):

```sh
DEMO_HOME=$(mktemp -d)
echo "$DEMO_HOME"
ULTIMATE_PROJECT="$PWD" ULTIMATE_SUPERVISED=0 ULTIMATE_GENERATION=1 \
  ULTIMATE_FAUX=1 ULTIMATE_HOME="$DEMO_HOME" ULTIMATE_PORT=4800 \
  ULTIMATE_CLOUD_URL=ws://127.0.0.1:8787/sync ULTIMATE_CLOUD_TOKEN=dev pnpm dev
```

The explicit `ULTIMATE_CLOUD_URL` overrides user settings and opts this faux host into sync; faux and preview hosts otherwise stay silent. The environment token overrides the `ULTIMATE_CLOUD_TOKEN` secret. Real hosts can instead use user settings `cloud.url` and the Secrets panel; see `extensions/cloud/README.md`.

Explicitly setting `ULTIMATE_PROJECT` and clearing supervised mode avoids inheriting the running Ultimate host's project and supervisor environment when launched from an agent terminal. Use a free machine port, not the running host's port or state home.

1. Create two conversations with `POST /api/conversations` (JSON `{}`); note each returned `id`. Send text with `POST /api/conversations/<id>/submit` (JSON `{"text":"Replica check"}`). The faux provider answers without model tokens. Repeat about 18 turns on one conversation to build more than 64 entries.
2. Open `http://127.0.0.1:4800/?conversation=<id>` and `http://127.0.0.1:8787/?conversation=<id>`. Expand **Earlier** in the sidebar; the lists and transcripts should match. To exercise history paging, compact the long conversation with `POST /api/conversations/<id>/compact` (JSON `{}`) and wait for completion.
3. Stop only the faux machine with Ctrl+C. Reload the cloud URL: the list and transcript remain readable and an amber notice explains that this is the last synced state. Switch conversations, open the side panel, and use **Load earlier messages** at the top of the compacted transcript. Its history request should return 64 entries and a `before` cursor while more remain.
4. Send a distinctive prompt at the cloud URL. It appears above the composer as a queued follow-up. Restart the machine with the **same** `DEMO_HOME` and environment. The queue clears and a faux answer appears. In `GET /api/events?conversation=<id>`, count the `view.entries` whose `kind` is `pi.user` and whose user-model content equals the distinctive text: exactly one should exist. Count before compacting again, since `view` contains the active transcript, not all stored history.
5. Stop both terminals with Ctrl+C. Local replica data remains in `cloud/.wrangler/`; machine state remains only in the temporary home. Neither is needed after the experiment.

### Quiet offline reads

The replica's `system` snapshot is marked `offline: true`; the web store shows the offline notice once per transition into offline, not again when facets reopen the event stream. Unsupported replica requests return 503 with the same `offline: true` marker. The web SDK distinguishes this expected unavailability from real HTTP failures: `useAction` status queries settle without data or an error toast; durable UI writes retain their tab-local overlay instead of rolling back the selected conversation or panel. Those offline UI choices are not persisted or replayed to the machine; reload discards them. Deliberate unavailable actions still reject, and an unhandled one shows a warning. Unmarked 503s and other failures retain normal error handling.

During open, conversation switching, scrolling and opening the Info panel, the unavailable requests are `POST /api/ui` and extension actions `instance/list`, `onboarding/status`, `workspaces/isolation`, `tailscale/status`, `fast/status`, `status-line/rates`, and `secrets/list`. These all use the same SDK handling, not per-facet substitutes. DevTools still records their expected 503s. Events, models and history are served successfully from the replica. Unsupported request bodies are drained before replying so Wrangler does not fail its forwarding stream with a 500. Models are synced in the same `{ providers, models }` shape as the machine's API.

## Routing and data

Every `/api/*` request first requires a Cloudflare Access JWT verified by the Worker (RS256, issuer, audience, expiry and not-before); missing configuration or verification failure returns a generic 401 before touching the replica. `/sync` uses only its bearer token. Both routes then go to `Replica`, named `replica`; static assets carry no data and remain asset-first. Other routes serve static assets with SPA fallback. `/sync` requires `Authorization: Bearer <SYNC_TOKEN>` and accepts one machine WebSocket after its project hello passes, replacing any previous accepted connection. It stores batches atomically and returns cursor hashes and acknowledgements. Retired documents are deleted.

The first `hello.project` durably binds the replica to one project, including existing trial data; a different project is closed with `PROJECT_MISMATCH` (`4009`) without receiving a cursor or changing data, and its host stops retrying.

With a machine socket open, API requests stream through the `MACHINE` VPC service binding (or `MACHINE_ORIGIN` only in local development), with loopback Host/Origin and without forwarding/browser admission headers. A failed GET falls back to the last synced data. A failed write returns 502 instead: its response may have been lost after the machine committed it, so check before retrying. Browser requests must have no fetch-site header or use `same-origin`/`none`, and any Origin must match the cloud URL, before headers are rewritten or prompts are queued. Without a machine, events, history, and models come from the replica. Live task state is omitted. Text submissions queue in an outbox and are resent until the machine acknowledges delivery. Queue IDs are negative local integers; the delivery identity is a UUID, used by the machine for exactly-once admission. Offline cancellation is not supported: the existing cancel button returns the offline error and leaves the item queued. All other offline API operations return 503. An offline SSE connection closes when the machine connects so the browser reconnects to the live proxy.

Several machines, matching the UI build to the machine, and offline images/actions/configure/abort/compact remain out of scope.

## Deploy

The committed `wrangler.json` is generic. Your domain and machine binding are personal and stay out of this repository: they live in your user settings, and `pnpm cloud:deploy` writes them into the gitignored `cloud/wrangler.deploy.json` before deploying. No credentials belong in the repository or in command arguments. Run commands from the repository with Wrangler logged in to the account that holds your domain's zone.

1. Create a remotely managed tunnel for the machine and an HTTP VPC service through it to Ultimate's port:

   ```sh
   pnpm exec wrangler tunnel create ultimate-<machine>
   pnpm exec wrangler vpc service create ultimate-<machine>-4747 --type http \
     --tunnel-id <tunnel-id> --ipv4 127.0.0.1 --http-port 4747
   ```

   The service ID it prints is bound as `MACHINE` at deploy (step 6). The [VPC API](https://developers.cloudflare.com/workers-vpc/api/) fixes the destination to this service; the request URL supplies Host (and SNI for HTTPS), not routing. We use `http://127.0.0.1:4747` so Ultimate's existing loopback Host/Origin checks admit it. SSE bodies pass through unchanged.

2. Run the tunnel in the logged-in user's session. Install cloudflared and ensure Wrangler's OAuth login exists for that user. Create `~/.config/systemd/user/ultimate-tunnel.service`, substituting absolute paths for your checkout and `pnpm` executable (`command -v pnpm`):

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

   Wrangler fetches the remotely managed tunnel credential through its authenticated API; do not extract or paste a tunnel token. This user unit stops with the user session unless linger is enabled; no system unit or root credentials are needed.

3. In Zero Trust → Access → Applications, create a self-hosted application for your hostname, using your login method (for example one-time PIN) and an allow policy for yourself. Add a separate, more-specific application for `<hostname>/sync` with a **Bypass** policy (Everyone). Only `/sync` bypasses Access, and it still requires the Worker bearer token. Keep the main application's session duration appropriate for browser use.

4. Read the team domain (`<team>.cloudflareaccess.com`) in Zero Trust settings, and the application's **Application Audience (AUD) Tag** in its configuration; it is also the `kid` parameter of the login redirect. Store both as Worker secrets, so they stay out of this repository and survive every deploy:

   ```sh
   pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN --config cloud/wrangler.json   # hostname only, no scheme
   pnpm exec wrangler secret put ACCESS_AUD --config cloud/wrangler.json
   ```

   Missing values intentionally refuse all API requests. Never set `ACCESS_DEV_BYPASS` on the deployed Worker. The Worker independently verifies JWTs even if Access is accidentally bypassed. `workers.dev` and preview URLs are disabled; the only route is the custom domain.

5. The user sets the sync secret interactively, using the same value as `ULTIMATE_CLOUD_TOKEN` in Ultimate's Secrets panel (⌘K → Secrets):

   ```sh
   pnpm exec wrangler secret put SYNC_TOKEN --config cloud/wrangler.json
   ```

   Do not put the value in arguments, files, logs or chat.

6. In `~/.ultimate/settings.json`, set the sync URL on your hostname and the VPC service ID from step 1:

   ```json
   { "cloud": { "url": "wss://<hostname>/sync", "vpcService": "<service-id>" } }
   ```

   `cloud.url` is what Ultimate syncs to; `pnpm cloud:deploy` also takes the custom domain from its hostname and binds `vpcService` as `MACHINE`. Deploy once the Access configuration is ready:

   ```sh
   pnpm cloud:deploy
   ```

   Restart Ultimate, with the sync secret already in its Secrets panel. Verify the hostname asks for the PIN; without a valid JWT `/api/*` returns no data. Verify live requests with Ultimate on, and offline history with it off.

7. Adding another machine later requires its own tunnel, VPC service and Worker binding, followed by a deploy. This first deployment supports only one project/replica and one bound machine; directory and per-machine routing must land before multiple machines can use it simultaneously.
