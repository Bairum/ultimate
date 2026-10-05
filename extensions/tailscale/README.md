Expose this Ultimate over Tailscale HTTPS, admitting only explicitly allowed Tailscale logins. This built-in is opt-in and manages its own Serve mapping; it never enables Funnel.

## Enable

Only the user file `~/.ultimate/settings.json` can enable exposure:

```json
{
  "extensions": { "enable": ["tailscale"] },
  "tailscale": { "allow": ["you@example.com"] }
}
```

Omit `tailscale.allow` to allow only the machine owner's login (`Self.UserID` → `User.LoginName` in `tailscale status --json`). Project settings cannot enable exposure or change the allowlist. A project-only enable produces a notice and remains disabled. Install Tailscale, log in, enable HTTPS certificates in the admin console, and grant operator rights if needed with `sudo tailscale set --operator=$USER`.

## Stable project URLs

`~/.ultimate/tailscale.json` stores `{ "ports": { "<absolute project root>": 4747 } }`, atomically written under a short-lived registry lock. A new project prefers its local supervisor port if free; otherwise it chooses the next free port from 4747. Port 443, existing Serve ports, and other registered projects are excluded. The HTTPS port stays assigned across shutdowns; its mapping always targets the current local supervisor port. Thus restarting projects in another order does not change their URLs.

An existing project assignment can replace its stale root proxy to another `http://127.0.0.1:<port>`. Foreign targets, extra path handlers, and Funnel mappings are conflicts and are not modified. Shutdown, disable, and reload remove only a mapping this facet created, keeping its registry assignment. No other Tailscale configuration is changed. After a crash, restart the project to replace the stale mapping. If a crash leaves the registry lock directory behind, the error explains how to remove it when no instance is starting.

## Security

Tailscale Serve replaces identity headers itself, so spoofed `Tailscale-User-Login` values never reach Ultimate through Serve. Those identity headers are absent for Funnel and tagged devices; these requests are denied. Shared-device users have their own logins and are excluded unless explicitly allowed. Both Host and any Origin must match the registered HTTPS origin; API, SSE, actions, assets, and HMR all require the allowed identity. The local listener remains loopback-only. User-level enablement and configuration are deliberate machine-owner decisions, never repository settings.

## Status action

`POST /api/extensions/tailscale/actions/status` with `{ "args": null }` returns:

```ts
{ state, url?: string, allow: string[], hint?: string }
```

States are `disabled`, `starting`, `ready`, `not-installed`, `not-running`, `not-operator`, `https-disabled`, `port-conflict`, and `error`. `url` exists when ready. `hint` explains setup failures; `allow` lists the effective logins, never credentials. System info also publishes the registered URL in `access.origins`. No identity values are logged.
