This is Ultimate's own repository, and this setup is the one it is built with: Ultimate plans, delegates, checks its
work, and changes its own code while you talk to it.

## What it adds

Every built-in is already on; this setup adds how the repository is landed and reviewed:

- `settings.json`: each worktree isolate installs its dependencies, and the lander runs `pnpm check`, then
  `pnpm test`, `pnpm test:e2e` and `pnpm eval` in parallel, and pushes to `origin`.
- `agents/lander.md`: the lander fixes a submission that fails to land, then lands it once every check passes again.
- `agents/reviewer-*.md`: the review team (correctness, simplicity, architecture), each on its own model; the shipped
  `reviewer` starts them in parallel and returns one merged verdict.
- `skills/ultimate-cloud-dev`: working on this repository's Worker (`cloud/`): probe Workers, rolling deploys,
  Durable Object resets and deep telemetry. @sync deploys it.

## How to work with it

See [the work model](../AGENTS.md#how-work-is-organised-a-forest-of-conversation-trees) for coordination and
[Surfaces](../README.md#surfaces) for apps beside the conversation.

## How it runs

See [reload layers](../AGENTS.md#layers-and-how-they-reload), [running the server](../docs/running.md) and
[durability](../docs/durability.md) before changing the running system.

## Read more

`README.md` to start, `AGENTS.md` for the reload layers and the rules, `extensions/README.md` to write extensions.
