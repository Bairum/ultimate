# Cloud sync

An optional machine-side replica sender. With `ULTIMATE_CLOUD_URL` unset it does nothing. With a URL it opens one outbound WebSocket, sends conversation records, own entries and conversation documents, then streams committed changes. Reconnects compare entry IDs and document hashes; acknowledgements limit outstanding batches to four. Session and task documents stay local.

Environment only (no settings or Secrets integration for this spike):

- `ULTIMATE_CLOUD_URL`: sync endpoint, e.g. `ws://127.0.0.1:8787/sync`.
- `ULTIMATE_CLOUD_TOKEN`: bearer token for that endpoint.
- `ULTIMATE_CLOUD_MACHINE`: machine name, defaulting to the OS hostname.

The cloud implementation and shared wire contract live in `cloud/`. Prompts queued there are submitted locally with the outbox UUID as Pi's `requestId`, so retries admit one submission. Unknown conversations produce a notice and leave the item undelivered. Closing the host closes the socket; failed connections retry with a 1–30 second backoff.
