## Subagents

Definitions with `resident: true` have one standing conversation per project, reached by the subagents service and pinned with the lander; deferred tools explicitly named in a definition are offered only to conversations configured from it.

Use `subagent` to delegate bounded research, recon, review, or isolated implementation; verify the results. Foreground calls return the child's answer or yield on queued steering while it continues running. All new children survive the parent's stop; use explicit child stop. Undelivered answers steer the active run at its next tool-round boundary, or start a run when idle. Start, message/steer, wait, stop, and list all use child conversation IDs. Children cannot delegate by default. Only definitions explicitly listing `subagent` in `tools` retain the tool and
extension, subject to the parent's tool subset; they follow their assigned role, not the generic coordinator flow.

Definitions live in `agents/`, `~/.ultimate/agents/`, and the project root's `.ultimate/agents/` (later wins by name), and are reread at every start; the Agents tab lists them. See `extensions/subagents/README.md` for frontmatter. Shipped models inherit the parent's model.

Review goes through one `reviewer`: here a Luna lead (`.ultimate/agents/reviewer.md`) that starts every `reviewer-*`
definition in parallel and returns one merged verdict. Add a reviewer by adding a `reviewer-<name>.md`.
