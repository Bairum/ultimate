# Workspaces

New isolated conversation creates a separate Git checkout; ordinary New stays shared.
Subagents can select `isolate: "worktree"` for the same setup.
Check out a source branch first; uncommitted source changes are not included.

Each conversation has one record in the root `ultimate.workspaces` document.
Its path is `<home>/worktrees/<conversationId>`; its branch includes the home hash and conversation ID.
Preparation runs `isolates.worktree.setup` with `ULTIMATE_SOURCE` set to the source checkout.
Setup commands must be safe to repeat after interruption.
The first model request waits for preparation; failed or removed workspaces block tools with the reason.
Failed setup keeps its output tail and never force-removes dirty output. Start a new conversation to try again.

The Workspaces panel shows every checkout, including empty, archived and removed conversations.
`info {id}` reads the record and current tips; `create {cwd?, title?}` returns a new conversation ID.
`land {id}` fast-forwards the saved source branch to the clean, verified workspace tip.
Both checkouts must be clean; another running conversation or queued input prevents landing.
If the target changed or diverged, update the workspace onto it and verify again; landing never rebases or pushes.
`discard {id, confirm: true}` removes a clean checkout and keeps its branch and history.

Top-level mains use `workspace status` and `workspace land` for their own checkout.
Own tool landing skips the calling conversation's run and inbox checks; UI landing does not.
Landing reports commits and changed paths, with a restart hint for core changes to the running clone.
Archive and clear context never remove a checkout. Landing never restarts Ultimate.
