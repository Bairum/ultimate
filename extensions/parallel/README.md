Search the public web and fetch clean page content with parallel.ai through `web_search` and `web_fetch`. Opt in by enabling both `parallel` and `secrets` in settings.

Set `PARALLEL_API_KEY` in the Secrets panel (⌘K → Secrets), obtained from https://platform.parallel.ai. The user-global secret store takes priority over `PARALLEL_API_KEY` in the server environment. Missing credentials produce a tool error and one process-local notice, never an in-chat credential form.

Calls are read-only and replay-safe, with a 120-second timeout and cancellation. Text output is capped at 50 KiB / 2000 lines; structured details carry results, excerpts, pages, errors, and warnings. For raw files, APIs, JSON feeds, and localhost, use curl instead.

Ported from [HazAT/pi-parallel](https://github.com/hazat/pi-parallel) at `75d933b`, MIT, Copyright (c) 2026 haza. Parameter schemas, request shaping, guidance, and output limiting follow that extension; adapted to Pi Durable. See the upstream MIT license. `ULTIMATE_PARALLEL_TEST_URL` overrides the API base only for local fake-server tests; never set it in production.
