Run an on-demand second Ultimate to test core changes before restarting the shared host. Start it, check its API and UI, then stop it. Creating a conversation never starts a preview automatically.

`instance` supports start, stop, logs and list. An isolated caller previews its ready workspace; `start {subagent: <child id>}` selects an owned child's workspace. A shared caller previews the host source and project. Workspace previews require `server/main.ts` and `node_modules`; run `pnpm install` first. Previews do not prevent landing or removal.

Start uses a temporary home unless a separate home is supplied. A preview cannot share the host's home or another running preview's home. The child binds to localhost port zero; the tool reads its `Ultimate: <URL>` stdout line and checks `/api/models`. Startup has a 60-second deadline, with the output tail included in errors.

Set `faux: true` for token-free testing; otherwise previews use real models. No state is copied; a workspace preview follows its main checkout's project decision, as every linked worktree does. Each preview keeps its own SQLite storage and Vite cache.

Logs returns the last 200 lines; list shows running instances. At most three may run, including starts in progress; shutdown stops them all. Temporary homes remain for inspection. The tool is not replay-safe. Returned URLs work with screenshot or browser.

`web.tsx` renders instance cards with URL, pid and home, plus collapsible logs.
