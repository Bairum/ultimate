# Update

Keeps the Ultimate clone the host runs from (`host.ultimateRoot`, the `<self>` block's "Ultimate (running host)") current with its `origin`, by fast-forward only.

## Checking

Every running Ultimate compares the clone with `origin/<default branch>` every 5 minutes, and 30 s after start. That comparison is local and costs nothing. It fetches origin only when the clone's last fetch is older than an hour. The last fetch is read from `.git/FETCH_HEAD`'s mtime, so several Ultimates on one clone (each project's host, the machine home) fetch at most once an hour between them, and a fetch by hand counts too. The fetch uses `lib/fast-forward.ts`, which retries a GitHub origin over the other transport (SSH ↔ HTTPS), and git never prompts. Faux servers and previews never check.

## Status line

While the clone is behind, the status line shows `↓ 5 new · update` (`↓ 5 new` on a phone). It is amber with a warning icon when an update would be refused. The popover shows:

- the clone's path;
- how far `main` is behind;
- the newest 5 commits and a DiffsHub ↗ link to the range (GitHub origins);
- what the range touches: extensions and web, server, lockfile, bin;
- what each of those needs after an update:
  - extensions and web reload by themselves;
  - server or a changed lockfile need a restart of every Ultimate running from the clone;
  - a changed lockfile also needs `pnpm install`;
  - bin needs a supervisor restart.

**Update now** runs the update. After an update that needs a restart, the item reads `updated · restart`, and the popover offers **Restart now** (the core swap, as `core changed · restart` does). Nothing restarts by itself.

## Updating

`update` (user-only):

1. Fetches origin.
2. Fast-forwards the default branch with `git merge --ff-only`.
3. Runs `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` differs from the installed `node_modules/.pnpm/lock.yaml`. A failed install is retried by the next update.

It refuses, and changes nothing, when:

- the clone has uncommitted changes to tracked files;
- it is on another branch or detached;
- it has diverged from origin;
- the lander is landing into the clone: on a machine where the clone is also the project, landings fast-forward the same branch.

It never stashes, rebases or resets. A refusal's popover offers **Ask @sync**, a link to this machine's home.

## Events

Each update records a durable event, emitted in its own commit right after the change, because the clone lives outside storage. A crash in between loses the event, not the update.

- `update.applied`: `{ root, from, to, commits, layers, install }`, for an update that moved the clone.
- `update.refused`: `{ root, reason }`.

## Faux

A faux server answers a demo: 5 commits behind, touching server and the lockfile. `demo {state: 'behind' | 'refused' | 'updated' | 'current'}` switches it for previews, and Update now moves the demo to `updated`, or stays `refused`.
