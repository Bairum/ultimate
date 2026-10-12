Delegate a bounded foreground task to Claude Code and receive its final Markdown answer as a distinct external subagent result.

Requires `claude` on Ultimate's PATH, installed and already authenticated (check `claude --version` and `claude auth status`). This extension does not install the CLI or change authentication. It is automatically discovered when this project is chosen as local.

## Tool

`claude_code` accepts:

- `prompt` (required), `model` (default `opus`, currently resolves to `claude-opus-5-5`).
- `maxTurns` (default 10), `timeoutSeconds` (default 300, positive, at most 2147483), optional positive `maxBudgetUsd`.
- Optional `effort`: `low`, `medium`, `high`, `xhigh`, `max`; `agent`; `appendSystemPrompt`.
- `tools`: built-in names, default `Read`, `Glob`, `Grep`; `[]` disables tools. Optional `allowedTools` controls pre-approved tools.
- `permissionMode`: `dontAsk` (default), `plan`, `acceptEdits`. No permission bypass.

Example Opus review:

```json
{
  "prompt": "Review .ultimate/extensions/claude-code/runner.ts for correctness. Do not modify files. Return findings with file paths and line numbers.",
  "model": "opus",
  "maxTurns": 5,
  "maxBudgetUsd": 1,
  "timeoutSeconds": 120,
  "effort": "high"
}
```

Each call waits for one fresh print-mode CLI invocation in the calling agent's working directory (including its worktree). Prompt goes through stdin, options through separate argv, without a shell. Inherited MCP servers are excluded with strict empty MCP configuration. Claude settings, instructions, plugins and hooks still apply: read-only defaults are **not an OS sandbox**. Enabling other tools or `acceptEdits` can change files. Budget is the CLI's estimate, not a strict billing guarantee.

Progress reports actual model/session, latest activity, turns, cost, duration and permission denials when available. A failure subtype or `is_error` is a failure even with exit code zero; missing/malformed result, nonzero exit, authentication/spawn errors and output overflow are errors too. Combined stdout/stderr capture is capped at 1 MiB; overflow stops the CLI rather than silently truncating an answer. Timeout, cancellation and shutdown terminate the process group with SIGTERM, then SIGKILL after 250 ms, including stubborn descendants. This runner targets Ultimate's Linux environment.

Calls are not replay-safe and do not resume sessions after interruption: retrying may duplicate spend or edits. No native Ultimate child conversation or background runner is created.
