Tracks whether each model provider works on this machine, from every real response and an hourly heartbeat in the machine home, and shows an amber `<provider> failing` item in the status line while one does not.

## What is stored

One file per machine, `~/.ultimate/health.json`, written by every Ultimate home of the user:

```json
{
  "providers": {
    "anthropic": {
      "lastOk": 0,
      "lastFail": 0,
      "error": "invalid_grant",
      "lastChecked": 0,
      "lastUsed": 0
    }
  }
}
```

Times are epoch milliseconds. `lastOk` and `lastFail` come from real calls and pings, `lastChecked` from pings only, `lastUsed` from real calls only. A provider is `failing` when `lastFail` is newer than `lastOk`, `ok` once it has a `lastOk`, otherwise `unknown`. Writes read, merge each field by its maximum (the `error` stays with the newest `lastFail`) and rename a temporary file into place; two homes writing at once lose at most one event. An error is stored only as a structured summary: the HTTP status (when the message starts with it or names it, `status 401`) and the words of a fixed list of provider error codes and network errors it contains (`invalid_grant`, `rate_limit_error`, `overloaded`, `ECONNREFUSED`, …, `KNOWN` in `store.ts`), or "request failed". Its free text never is, so no request or auth contents reach the file or the cloud; add a code to `KNOWN` to keep it. The cloud report goes out after every tick that pinged, at least hourly, and after a failed attempt on the next tick. A move's checks ping a provider marked failing before they block (`cloud/login.ts`).

## Login changes

A login says nothing about the one it replaced, so a change starts that provider over at `unknown` (`reset` in `store.ts` drops its entry). Ultimate's own login and logout (`extensions/models`) reset the provider when they finish. The machine home also watches Pi's `auth.json` (its directory, since Pi replaces the file) and resets each provider whose login appeared or disappeared there, as `pi` /login or /logout do; a provider without an entry is due at once, so the next tick pings it and reports to the cloud. A token refresh rewrites the file without changing its providers and resets nothing. Only the file's provider names are read, never its values.

Every machine keeps its own logins: never copy `auth.json` between machines. OAuth logins rotate their refresh token, so the first refresh on one machine revokes the other's copy with `invalid_grant`.

## Real usage

A `GenerationTask` `afterResponse` hook records every terminal provider message at no cost: `stopReason: 'error'` records a failure with `errorMessage`, `aborted` nothing, anything else a success. The write never blocks or fails the generation. A faux server records nothing.

## Heartbeat

Only the machine home (`~/.ultimate/machine`) pings, never on faux. Every 10 minutes (and 30 s after start) a single-flight tick picks each provider with configured credentials and an available model, and pings those due:

- the interval follows the machine's activity, the time since the last real call on any provider: under 4 h idle every hour, under 12 h every 4 hours, beyond (or never used) every 8 hours;
- a provider is due when its last success or ping is older than the interval, or when it is failing and its last ping is older than 15 minutes, so a one-off error clears quickly.

A ping asks the provider's cheapest available model (lowest `cost.input + cost.output`) `ping` with `maxTokens: 16`, one provider after another, and records `lastChecked` plus a success or failure. That is at most 24 pings per provider per day of about 20 tokens each. A `claude-code` ping starts the Claude Code CLI on its subscription.

## Cloud report

With cloud sync configured (`cloud.url` and `ULTIMATE_CLOUD_TOKEN`, see `cloud/README.md`), the machine home posts `MachineHealth` (`cloud/protocol.ts`: `{ machine, at, providers }`) to `POST /sync/health` after a tick that pinged and at least once an hour. A failed report is retried on the next tick.

## Actions

`state` returns `{ machine, providers: ProviderHealth[] }` for this machine (machine from cloud settings, else the hostname). A faux server answers a fixed demo: `openai-codex` ok, `anthropic` failing with `invalid_grant` 3 hours ago, `claude-code` unknown.

## Status line

In every home the status line polls `state` every minute and shows an amber `<provider> failing` (or `2 providers failing`) only while a provider fails; its popover lists each failing provider's error and age. A move's checks step also refuses a failing default provider (`cloud/login.ts`).
