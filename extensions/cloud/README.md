# Cloud sync

An optional machine-side replica sender, inert until configured. With a URL and token it opens one outbound WebSocket, sends conversation records, own entries and conversation documents, then streams committed changes. Reconnects compare each conversation's newest own entry ID and document hashes. Catch-up streams entries and documents page by page, waiting for room in the four-batch acknowledgement window before reading more; history reads do not hold Pi's commit line. Session and task documents stay local. Pending records and buffered changes share a fixed 16 MiB retained-data limit; crossing it closes the socket, discards the buffers, and reconnects with the normal backoff to resume from the replica's durable cursor. During catch-up, document and conversation changes retain only IDs, not intermediate values.

Configure once in **user** settings (`~/.ultimate/settings.json`):

```json
{ "cloud": { "url": "wss://example.com/sync", "machine": "my-machine" } }
```

Add `ULTIMATE_CLOUD_TOKEN`, the endpoint's bearer token, in the Secrets panel (⌘K → Secrets). `machine` is optional and defaults to the OS hostname. Project settings are never read: a repository cannot redirect the user's history to another server. Configuration is read at host open; restart after changing it.

Environment overrides take precedence, for process-scoped experiments:

- `ULTIMATE_CLOUD_URL` overrides the user URL.
- `ULTIMATE_CLOUD_TOKEN` overrides the secret.
- `ULTIMATE_CLOUD_MACHINE` overrides the user machine name.

Faux hosts and preview instances stay silent and do not sync from user settings. An explicit `ULTIMATE_CLOUD_URL` enables them for local experiments (with a token from the environment or Secrets). Previews strip all three cloud environment variables inherited from their parent. A configured URL without a token produces one notice naming the missing secret, and no connection.

Every host connects with its machine name and absolute project root in the sync URL, so projects on the same machine have separate replicas. Hello repeats that identity and carries the instance's HTTP port from system info. A mismatched identity or invalid port is refused with close code `4009`; the host reports it and stops retrying. The cloud directory at `/` links to stable `/p/<machine>/<project>/` URLs, each with live requests through its own port and offline history when stopped. Running instances always appear; offline instances with zero synced entries are forgotten. Empty summary lists during host opening/closing are ignored, preserving the last non-empty list.

For live routing, the deploying user's `cloud.tunnels` maps exact machine names to tunnel IDs: `{ "cloud": { "url": "wss://example.com/sync", "tunnels": { "my-machine": "<tunnel-id>" } } }`. This replaces `cloud.vpcService`. Adding a machine means creating/running its tunnel, adding that map entry, and deploying again; extra projects/ports need no new bindings. Without a matching machine binding the replica is offline-only. See `cloud/README.md` for setup and local two-host verification.

System info is compared once a second, ignoring `machine.freeMemory` and the SQLite `persistence.sizeBytes`/`walBytes` counters. Meaningful changes (including build and extensions) send immediately; a full snapshot also refreshes every 60 seconds so volatile Info values are at most a minute stale. Each connection sends the full non-empty summary list once; subsequent messages contain only changed summaries and removed conversation IDs. An empty host conversation list is ignored during opening/closing, as an open host always has its root. If the oldest unacknowledged batch exceeds 60 seconds, the sender raises one `Cloud sync stalled: no acknowledgement for 60 s; reconnecting` notice, closes the socket and resumes through the normal reconnect/cursor path.

The same connection also publishes a per-project production UI build, including trusted enabled project web facets. The host checks a source fingerprint every five seconds, waits 60 seconds of quiet after changes, and runs at most one low-priority Vite child at a time. It uploads only R2 files reported missing, using the same bearer token in an Authorization header. The cached build lives in the instance home; the replica and Directory retain its content-hashed `uiBuild` while offline. Cloud HTML and build assets are behind the Worker's JWT check, and a changed UI build triggers the existing reload notice. See `cloud/README.md` for the shared-asset layout, limits, bucket setup and retention policy.

The cloud implementation and shared wire contract live in `cloud/`. Prompts queued there are submitted locally with the outbox UUID as Pi's `requestId`, so retries admit one submission. Unknown conversations produce a notice and leave the item undelivered. Closing the host closes the socket; failed connections retry with a 1–30 second backoff.
