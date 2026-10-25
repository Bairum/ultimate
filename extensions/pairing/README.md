Pairs browsers with Ultimate: a notice on an unpaired browser with a one-click "Pair this browser", and ⌘K **Pair a device…** for a phone's single-use link and QR code.

## Why

User-only clicks (answering a question card, granting, Secrets, sending from the composer, Stop) need a browser that
holds the HttpOnly pairing cookie (see "Pairing" in `docs/running.md`). An unpaired browser's click is refused with a
403 `Pair this browser with Ultimate to do this`; without this extension the click seems to do nothing.

## Notice

The SDK reads `GET /api/whoami` at start, when the tab comes back into view or gains focus, and when the stream opens
again (`usePairing()`, `web/src/sdk/pairing.ts`); every refused call is recorded there too. The notice, bottom right:

- shows at once when this browser may not act as the user (`user: false`), and whenever a click is refused for want of
  pairing (`refusedAt`); the core then shows no raw error notice for that refusal. Dismissed, it waits for the next
  refusal.
- **Pair this browser** posts `/api/pair`: the server opens a pairing link in this machine's browser of the same kind.
  The notice then says a pairing tab opened; once whoami reports `host` on return, it confirms "This browser is
  paired." for a few seconds. 429 and 403 (a remote device) show as a short error line with what to do instead.
- On a page reached remotely (not `localhost`), it points to ⌘K Pair a device… in a paired browser instead of the
  button.
- Never on a page the browser tool drives (`sessionStorage['ultimate.driven']`), which is unpaired by design.

## Pair a device…

Only in a paired browser. The dialog mints a link with `POST /api/pair/link` (single use, 10 minutes) and shows it
with a QR code and Copy link. It defaults to the tailnet address when Tailscale serves this Ultimate
(`system.access.origins`), with a switch to this page's address; New link mints another.
