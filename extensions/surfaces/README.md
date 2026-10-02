Tells the main conversation which surface the user is looking at, so a request such as "this list is too slow" is
read against the right screen. The web host records the surface on screen as `shell.shownSurface` (`{ id, title }`)
in the durable UI state; this server facet turns it into one line of the system prompt, which changes only when the
surface does. Subagent conversations do not get it.
