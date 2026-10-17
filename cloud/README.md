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

## Routing and data

Every `/api/*` and `/sync` request goes to `Replica`, named `default`; other routes serve static assets with SPA fallback. `/sync` requires `Authorization: Bearer <SYNC_TOKEN>` and accepts one machine WebSocket, replacing any previous connection. It stores batches atomically and returns cursor hashes and acknowledgements. Retired documents are deleted.

With a machine socket open, API requests stream through to `MACHINE_ORIGIN`, with loopback Host/Origin and without forwarding/browser admission headers. A failed connection falls back to the last synced data. Without a machine, events, history, and models come from the replica. Live task state is omitted. Text submissions queue in an outbox and are resent until the machine acknowledges delivery. Queue IDs are negative local integers; the delivery identity is a UUID, used by the machine for exactly-once admission. Offline cancellation is not supported: the existing cancel button returns the offline error and leaves the item queued. All other offline API operations return 503. An offline SSE connection closes when the machine connects so the browser reconnects to the live proxy.

This is a local spike, not a public deployment: authentication for the browser, Access/GitHub, tunnels, custom domains, several machines, matching the UI build to the machine, and offline images/actions/configure/abort/compact are out of scope. Do not expose the unauthenticated browser API publicly.
