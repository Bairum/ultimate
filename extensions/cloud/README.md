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

The cloud implementation and shared wire contract live in `cloud/`. Prompts queued there are submitted locally with the outbox UUID as Pi's `requestId`, so retries admit one submission. Unknown conversations produce a notice and leave the item undelivered. Closing the host closes the socket; failed connections retry with a 1–30 second backoff.
