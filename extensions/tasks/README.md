The live durable task graph in the right panel's Tasks tab: every conversation with live work, its tasks as a tree by owner (generation → tool calls → the conversations a task owns, such as subagents), each with its status (pending, the running phase, waiting on which tasks, completing), background and aborting marks, and how long this page has seen it. Click a conversation to show it.

Data comes from `useTasks()` (the server's `tasks` event) and `useConversations()`; tool names of the shown conversation's tool tasks come from `pi.live`.
