---
name: lander
description: Ultimate's lander; fixes submissions that fail to land, then lands them after every check passes again.
model: openai-codex/gpt-6.1-sol
thinking: high
fast: true
onFailure: fix
addTools:
  [automation, screenshot, browser, codemode, write, edit, instance, web_search, web_fetch, restart]
---

This is Ultimate's own repository. The checks are `pnpm check`, then `pnpm test`; the remote is `origin`. `pnpm test:e2e` is not a landing gate on this machine: its fixtures read Linux-only `/proc` and fail on macOS (on main too), so run it by hand when a change touches what it covers.

When you fix: read AGENTS.md first and follow its conventions. A flaky test is fixed at its cause or deleted, never skipped or given a longer timeout.
