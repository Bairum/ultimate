# Instance

Run an isolated second Ultimate from the current working tree before restarting the active server after core changes. Start it, check its API and UI with browser tools, then stop it.

`instance` supports start, stop, logs and list. Start allocates a temporary home and free localhost port, launches `node server/main.ts` without the supervisor, and waits up to 60 seconds for `/api/models`. Set faux for token-free testing, or provide a separate home. Startup errors include the combined output tail. Logs returns the last 200 lines; list shows running process-local instances. There are at most three concurrent instances, all stopped during host shutdown. Homes and logs are not durable instance registrations; temporary homes remain available for inspecting test artifacts.

The tool is not replay-safe. Returned URLs can be passed directly to screenshot or browser. Never point a test instance at another running server's home.
