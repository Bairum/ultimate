The project's conversations in the Agent surface's sidebar: list, create, switch, rename, clear, and archive them.
Several run at once, each a separate agent, and each knows about the others.

## Sidebar

The sidebar lists the top-level conversations that have a message, newest input first, so a row moves when its
conversation gets input (your message or a background subagent's report), not while it works. Empty conversations stay
out, except the shown one: an empty shown conversation is the draft, listed first as "New conversation". The shown row
is highlighted, also while one of its subagents is shown. Each row has its title (or `#id`) and the time of its latest
message (`now`, `5m`, `3h`, `2d`, then a date). Its leading mark pulses while it or any of its subagents works, and is
solid when an answer arrived since you last looked at it.

New conversation (the button, `mod+alt+n`, or the palette) shows an empty conversation on the Agent surface and
focuses the composer. It reuses the shown draft (a shown top-level conversation without entries), else the newest
empty, untitled, idle, unarchived conversation, and creates one only when there is none. From a top-level conversation
it takes that one's model and thinking level; from a subagent it sets none, so a reused conversation keeps its own and a
new one gets the main conversation's.

On hover or focus, a row's `…` menu offers Rename (inline; also on double-click; Enter or leaving the field saves,
Escape cancels, and after either key focus returns to the row), Clear context… (asks first; not while the conversation
itself works, as the server refuses), and Archive. Archived rows sit in a collapsed "Archived · N" group at the bottom,
where Unarchive brings them back; archiving the shown row shows the next one.

Commands, under Conversations: `conversations.new` ("New conversation", `mod+alt+n`) and `conversations.reset`
("Clear the context" of the shown top-level conversation, when it is idle and has entries). The UI state keeps archived
ids in `ext.conversations.archived` and, in `ext.conversations.seen`, the latest answer time seen per top-level
conversation; a conversation not recorded there counts as seen.

## Server facet

The `conversations` prompt section goes to every top-level conversation (neither a subagent nor a fork). It names the
conversation's own id and lists the other top-level conversations that have a message and are not archived (the web
keeps archived ids in the UI state `ext.conversations.archived`): at most the 10 most recently active, listed by id,
each as `#<id> <title or "untitled">` with its cwd when that differs. It holds no busy state or times, so it changes
only when that list, a title, or a cwd does, and prompt caches stay warm. It reminds the agent that the others share the
checkout unless a cwd says otherwise, and how to look at them with codemode's `ultimate.entries(id)` and
`ultimate.taskGraph()`. Without other conversations there is no section.

Actions, each on a top-level conversation; bad args, unknown conversations, subagents, and forks throw:

- `rename {id, title}`: sets the `ultimate.metadata` title, with whitespace runs (newlines too) collapsed to one space,
  trimmed, and cut to at most 160 characters; a blank title removes it, so the first message names the conversation
  again. Returns `{ ok: true }`.
- `reset {id}`: clears the conversation with a Durable reset (a `pi.reset` entry starts a new, empty context). It
  refuses while the conversation works. A conversation named by its first message keeps that name as its title.
  Returns `{ ok: true }`.
