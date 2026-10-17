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
```

Then run `pnpm cloud:dev` and open the URL Wrangler prints (normally http://localhost:8787). Local Durable Object data persists in `cloud/.wrangler/`. Stop with Ctrl+C.

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

Every `/api/*` and `/sync` request goes to `Replica`, named `default`; other routes serve static assets with SPA fallback. `/sync` requires `Authorization: Bearer <SYNC_TOKEN>` and accepts one machine WebSocket, replacing any previous connection. It stores batches atomically and returns cursor hashes and acknowledgements. Retired documents are deleted.

With a machine socket open, API requests stream through to `MACHINE_ORIGIN`, with loopback Host/Origin and without forwarding/browser admission headers. A failed connection falls back to the last synced data. Without a machine, events, history, and models come from the replica. Live task state is omitted. Text submissions queue in an outbox and are resent until the machine acknowledges delivery. Queue IDs are negative local integers; the delivery identity is a UUID, used by the machine for exactly-once admission. Offline cancellation is not supported: the existing cancel button returns the offline error and leaves the item queued. All other offline API operations return 503. An offline SSE connection closes when the machine connects so the browser reconnects to the live proxy.

This is a local spike, not a public deployment: authentication for the browser, Access/GitHub, tunnels, custom domains, several machines, matching the UI build to the machine, and offline images/actions/configure/abort/compact are out of scope. Do not expose the unauthenticated browser API publicly.
