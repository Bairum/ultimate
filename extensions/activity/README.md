The right panel's Activity tab: what happened in the project, newest first, from the durable event log.

Each event is one quiet line with an icon for its kind, what happened and its age:

- **Landing** (`workspaces.landed`): the feature tag and title it shipped, and its commit count, which opens the
  range in Review (with DiffsHub as a small ↗ beside it; without review the count links DiffsHub), as the root row's
  Landed lines do. Click opens the submitting conversation at the entry it submitted
  from.
- **Branch** (`lineage.branched`): the new branch as a conversation chip and the conversation it forked from.
- **Root** (`lineage.rooted`): the new root by its title.
- **Notice** (`ultimate.notice`): the extension and its message, amber for warnings, wrapping to two lines. It opens the
  conversation it happened in when the event's trace context names one.

Data comes from `useEvents({ events })` with the owners' tokens (`SubmissionLanded` from workspaces, `Branched` and
`Rooted` from lineage, `NoticeEvent` from `shared/events.ts`), which streams the root's `ultimate.event-feed` document
(the latest 100 events); other kinds stay out until they get a row. The
right panel is the place for it because the feed is project-wide, like Tasks and Agents, while the sidebar's root rows
already show each tree's own landings. `Show recent activity` in the command palette opens it.

Under faux, the `seedEvents {from}` action of the `faux` extension emits a realistic mix to preview it.
