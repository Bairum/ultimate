# Self

The replay-safe `restart` tool requests a type-checked blue/green core swap from the supervisor (`pnpm start`). Failed preparation returns diagnostics while the old core continues. Before storage is released, the tool records the next generation in its task memo; replay in the new owner returns the running generation and pid.

Call after changing `server/` or `shared/`. Never call for `web/`, `extensions/`, or `agents/`: those reload without a core swap. `POST /api/restart` requests the same swap and returns an accepted generation before handover; reconnect to `/api/events` to observe readiness.
