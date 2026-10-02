The project's conversations in the Agent surface's sidebar: list, create, switch, rename, clear, and archive them.
Several run at once, each a separate agent, and each knows about the others.

## Server facet

The `conversations` prompt section goes to every top-level conversation (neither a subagent nor a fork). It names the
conversation's own id and lists the other top-level conversations that have a message and are not archived (the web
keeps archived ids in the UI state `ext.conversations.archived`): at most the 10 most recently active, listed by id,
each as `#<id> <title or "untitled">` with its cwd when that differs. It holds no busy state or times, so it changes
only when that list, a title, or a cwd does, and prompt caches stay warm. It reminds the agent that the others share the
checkout unless a cwd says otherwise, and how to look at them with codemode's `ultimate.entries(id)` and
`ultimate.taskGraph()`. Without other conversations there is no section.

Actions, each on a top-level conversation; bad args, unknown conversations, subagents, and forks throw:

- `rename {id, title}`: sets the `ultimate.metadata` title, trimmed to at most 160 characters; a blank title removes
  it, so the first message names the conversation again. Returns `{ ok: true }`.
- `reset {id}`: clears the conversation with a Durable reset (a `pi.reset` entry starts a new, empty context). It
  refuses while the conversation works. A conversation named by its first message keeps that name as its title.
  Returns `{ ok: true }`.
