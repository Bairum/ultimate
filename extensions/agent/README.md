The built-in Agent surface: the conversation in a centred column, with the sidebar and the right panel beside it. It
is the home surface, shown by default and whenever another surface cannot be.

It is composed only of the primitives from `@/sdk` (`Header`, `Sidebar`, `Conversation`, `Panels`, `StatusLine`), so
it doubles as the smallest example of a surface. To change it for yourself or one project, copy this folder to
`~/.ultimate/extensions/agent/` or `<project>/.ultimate/extensions/agent/`; the copy wins by name. If the Agent surface
fails to load, the host still shows a bare header, conversation, and status line, so you can always ask for a fix.
