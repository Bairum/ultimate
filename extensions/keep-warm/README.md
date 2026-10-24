Keeps @ultimate's Claude prompt cache warm while you are away for a while, so your next message reads the whole conversation from the cache instead of writing it again. On by default; the `warm` chip in the status line turns it off.

## Why

Claude Code caches @ultimate's prompt for an hour after each request (`ttl: "1h"` in `@earendil-works/pi-claude-code`). A cache read costs a tenth of the input price, a one-hour cache write twice the input price. After a break of over an hour the next answer writes the whole context again: at ~550k tokens that is ~1.1M input-equivalent, against ~55k for a read. Each request that reads the cache renews its hour (Anthropic: "the cache is refreshed for no additional cost each time the cached content is used").

## How

- A timer outside the task scheduler (a pause holds the scheduler) looks once a minute. A ping is due when @ultimate's last request (its last answer or the last ping) is 55–60 minutes old, @ultimate is idle and runs on `claude-code`, and your latest input to it (typed, or an answer to its questions) is under 8 hours old. A cache already past its hour is cold, so no ping is sent to rebuild it.
- The ping replays @ultimate's committed context as its next request would send it (the `You are conversation #N.` identity first, as `conversations` adds it), plus one user line asking for `ok`. Claude Code reads the prefix up to @ultimate's last input from the cache; that renews it, and @ultimate's next real request reads it again.
- It sends no `sessionId`, so pi-claude-code runs it in a one-shot Claude Code process and @ultimate's own warm process is untouched. Nothing is written to any transcript; the response's usage is added to @ultimate's usage (`accountResponse`), so the status line's spend includes the pings.
- Skips while Ultimate is paused (`PauseApi`, which a rate limit also sets). A failed ping is recorded and blocks further pings until @ultimate's next request, so an outage or a limit is never retried in a loop.
- Not warmed: a system-prompt change (new instructions, sections, tools) still rewrites the cache on the next request. Pings only help idle gaps.

## State and actions

- `keep-warm.state` on conversation 1: `{ off?, last?, pings? }`; `last` is `{ at, read?, write?, error? }`.
- `state` → `{ on, lastRequest?, inputAt?, nextAt?, last?, pings }`.
- `set { on }` turns it on or off. User-only: pings spend the user's plan.

## UI

The `warm` chip in the status line: amber while the cache is warm, dimmed while off, red after a failed ping. Its popover has the switch, "Warm until 14:52" or "Cold since …", the next ping or why none is coming, and the last ping's read and write.
