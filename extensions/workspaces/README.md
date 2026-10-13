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
The workspace must be clean; another running conversation or queued input prevents landing.
Unrelated dirty files in the source checkout do not block; `git merge --ff-only` refuses only real overlap.
If the target changed or diverged, update the workspace onto it and verify again; landing never rebases or pushes.
`discard {id}` removes a clean checkout and keeps its branch and history.
`removeLanded` discards every clean, idle, ready checkout whose tip its target branch already contains.

## Lander

`workspace submit` (and the `submit {id}` action) queues a top-level main's clean tip in the root document's `queue`
and returns its position at once; the main keeps working. One background `workspaces.lander` task per source checkout
(`landers`) processes that source's entries in order, without a model:

1. Resets its own detached checkout, `<home>/lander/<hash of source>`, to the target branch tip. `isolates.worktree.setup`
   runs once when the checkout is created. With `lander.push`, it fetches the remote branch and merges it when it is ahead.
2. Merges the submitted tip. A conflict aborts the merge and reports the conflicting paths.
3. Runs `lander.checks` in order, each holding the `exclusive-commands` slot so they never overlap an agent's heavy
   command. A failing check reruns once: passing then is reported as flaky, failing again reports the output tail.
4. Fast-forwards the target branch in the source checkout (`merge --ff-only` when it is checked out). If the target
   moved meanwhile it starts again, at most three attempts.
5. With `lander.push`, pushes the target branch (never forced); a rejection integrates again once, then is reported.
6. Records `landed` and reports to the submitter as a follow-up input: commits, changed paths, flaky checks, whether it
   pushed, and "Needs restart." for `server/` or `shared/` changes to the running clone.

Settings (`.ultimate/settings.json`): `"lander": { "checks": ["pnpm check"], "push": "origin" }`; both are optional.
Each attempt starts from a reset checkout, and the integrated commit is memoized after the checks, so a crash resumes
safely. Failed submissions are dropped from the queue after their report.

Top-level mains use `workspace status`, `workspace submit` and `workspace land` for their own checkout.
Own tool landing skips the calling conversation's run and inbox checks; UI landing does not.
Landing reports commits and changed paths, with a restart hint for core changes to the running clone.
The Workspaces panel shows the lander queue, Submit and Land per checkout, and Remove landed.
Archive and clear context never remove a checkout. Landing never restarts Ultimate.
