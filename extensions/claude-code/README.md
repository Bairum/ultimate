# Claude Code delegates (opt-in)

Enable `claude-code` in `~/.ultimate/settings.json` or local project settings:

```json
{ "extensions": { "enable": ["claude-code", "subagents"] } }
```

Install Claude Code, run `claude` in a terminal, and use `/login` there once. Ultimate never reads or stores Claude credentials. The pinned Agent SDK launches the unmodified Claude Code binary using the same HOME; API keys, auth tokens and parent Claude session markers are removed from its environment. claude.ai connector MCP servers are disabled (`ENABLE_CLAUDEAI_MCP_SERVERS=false`).

Save `claude-worker.md` under `~/.ultimate/agents/` or the local project's `.ultimate/agents/`:

```markdown
---
name: claude-worker
description: Implement a bounded task with Claude Code
model: claude-code/opus
isolate: worktree
---

Implement only the requested change. Verify it and report concisely to your parent.
```

Models: `claude-code/opus`, `claude-code/sonnet`, `claude-code/haiku`, `claude-code/fable` (aliases are passed to Claude Code). Subagent start/message/stop and automations use the ordinary definition paths. Claude Code receives the definition instructions, a short Ultimate delegation section, and AGENTS.md when its cwd has no CLAUDE.md. Its preset and user/project settings remain native: `settingSources: ['user', 'project']` means your user-level Claude Code settings and hooks also apply to children. Ultimate's merged skills are symlinked into a generated plugin under the instance home.

Pi's durable conversation UUID is the Claude session id. A session becomes established when its first SDK transcript entries are committed to the mirror, or a successful result arrives. Only established sessions resume; otherwise the original input is retried with `sessionId`. SQLite records the turn before spawning, mirrors SDK transcript entries (deduplicated by UUID), and retains completed results until Pi can commit them. After a crash the next generation checks the recorded pid with portable `ps`, kills only a Claude-looking orphan whose command line has the recorded `--session-id` or `--resume` id (mismatches produce a notice and do not block recovery), and resumes with a continue prompt rather than repeating the original input. Internal Claude tools have Claude Code's recovery semantics, not Pi's exactly-once tool guarantees.

Tool steps appear as thinking progress; the final answer is rendered once as text. Claude Code owns its context management; Pi threshold compaction is disabled for these models, while aggregate usage and cost are still recorded. Pi's context meter is hidden for the unspecified context window. Matching Bash commands acquire the same `exclusiveCommands` lock as Ultimate bash and release it on completion, failure or stop. Ultimate MCP calls appear as normal tool entries, through the existing tool renderers.

## Durable Ultimate tools

An in-process SDK MCP server exposes the child's selected Pi tools as `mcp__ultimate__<name>`, including `codemode` and `screenshot` when available. Definition `tools` restrictions (or inherited tools) apply. Claude-native read/write/edit/bash/grep/find/ls and web search/fetch variants, plus `subagent`, are excluded. `restart`, `land`, and `discard` are excluded from inherited/default tool exposure; a definition may explicitly opt in through its `tools` list. The server passes Pi's TypeBox JSON Schema unchanged and marks screenshot read-only; Pi's tool contract has no general read-only metadata. Calls have a one-hour MCP timeout.

The PreToolUse hook captures Claude's tool-use id. Identical tool/argument requests consume captured ids FIFO; skipped ids are purged at top-level assistant message boundaries, turn completion, and post-tool failure/completion hooks. Native Claude subagent assistant messages do not prune the parent's ids. The MCP handler holds the request while the provider finishes its current generation with a real Pi tool call using that id. Pi Durable validates and executes it as an ordinary `pi.tool` task; the next generation resolves the held MCP request with the committed text/image result and error flag. The same query and its lifetime cancellation signal stay alive across these generations, including native exclusive Bash locks. No tool executes inside the MCP handler.

After query loss (crash, core swap, or MCP cancellation/timeout), Pi still owns the tool task. The provider resumes the Claude session with “your call to <tool> was interrupted by a restart; its result was: …; continue”, rather than issuing another call or repeating the user turn. Stop retires canceled input instead of continuing it on the next message. A retained query observes the conversation becoming idle without another generation and is interrupted, then force-killed only if still alive after a three-second grace. Its recorded pid remains available throughout that grace and is cleared only after teardown confirms exit, so a core crash during Stop still leaves a findable orphan. Fresh input arriving during recovery is appended to the continuation. A failed launch without session establishment removes the intent record, including first-iterator rejection and authentication-error result shapes, so retry starts rather than resumes a nonexistent session. Normal Pi replay policy applies: interrupted replay-safe tools may rerun as the same task; unsafe tools report interruption instead of duplicating side effects. Tests cover real codemode execution, fake screenshots, cancellation, query loss, and core SIGKILL, using only the fake runner.

## Limits and guardrails

- **Full autonomy:** bypassPermissions is enabled. Prefer worktree isolates; Claude Code may run arbitrary commands in its cwd.
- No true mid-turn steer: queued steer/follow-up input becomes a later turn.
- Ordinary individual use only. Do not configure continuous high-volume subscription automations.
- Use your own login inside **unmodified Claude Code**. Never extract subscription OAuth tokens or route Pi model requests through them. No Ultimate "Sign in with Claude" flow.
- Personal/end-user hosting is distinct from offering a commercial product. Recheck [Anthropic's legal and compliance policy](https://code.claude.com/docs/en/legal-and-compliance) and [Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview) before distribution or upgrading the pinned SDK. Authentication must complete in Anthropic's own flow.

Tests inject a fake runner explicitly via `claudeCode(host, runner)` and never invoke Claude Code. Live verification belongs to the coordinator and is not part of `pnpm test`.
