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
and returns its position and lander conversation at once; the main keeps working. One `workspaces.lander` task per
source checkout (`landers`) processes that source's entries in order, without a model.

The task runs in that source's lander conversation (`landerConversations`), created by the first submit in the same
commit as the queue entry: ownerless, titled "Lander · <target>", labelled `lander`, its cwd the lander checkout. It
has no workspace and is no main, so `workspace submit` and `land` refuse it. The task is its conversation's
foreground work, so the conversation list, the Agents tab and the Canvas show it working while it lands. It logs
every submission as `ultimate.lander` entries, which carry no model message, so no model run in that conversation
sees them: `queued`, `started`, each step, each check with `passed`, `failed` or `flaky`, and the outcome (`landed`
with `sha`, `commits`, `paths`, `flaky`, `pushed`, or `failed` with `reason` and the `output` tail). Each line is
committed with the task state change or doc update it describes; a check result is logged right after the check
runs, so a crash before its memo logs the rerun too. The same commits record each step as `{ step, at, check? }` in
the queue entry's `steps`; when the submission ends, its steps, outcome, tip and target move into the root document's
`results` (the latest 50).

The submitter follows the lander in its own transcript, from that document. The `workspace submit` card shows
`submit · <tip> → <target>` and a status chip (`queued #2`, the current step with a spinner, `Landed <sha> · pushed`,
`Not landed`); below it an "N steps" toggle, open while queued or landing and closed once finished, lists the step
rows and ends in a quiet "full log in #<lander>" link. The lander's report message renders as an outcome card with
a success, warning (landed, push failed) or error accent and the same collapsed steps. Nobody has to open the lander
conversation; it keeps the full log, grouped by submission, and shows on the Canvas and in the Agents tab.

1. Resets its own detached checkout, `<home>/lander/<hash of source>`, to the target branch tip. `isolates.worktree.setup`
   runs once when the checkout is created. With `lander.push`, it fetches the remote branch and merges it when it is ahead.
2. Merges the submitted tip. A conflict aborts the merge and reports the conflicting paths.
3. Runs `lander.checks` in order, each holding the `exclusive-commands` slot so they never overlap an agent's heavy
   command. A failing check reruns once: passing then is reported as flaky, failing again reports the output tail.
4. Fast-forwards the target branch in the source checkout (`merge --ff-only` when it is checked out). If the target
   moved meanwhile it starts again, at most three attempts.
5. With `lander.push`, pushes the target branch (never forced); a rejection integrates again once, then is reported.
6. Records `landed` and reports to the submitter as a follow-up input: the landed commit and commits, flaky checks,
   whether it pushed, "Needs restart." for `server/` or `shared/` changes to the running clone, and the lander
   conversation id for the full log (changed paths and output tails live there).

Settings (`.ultimate/settings.json`): `"lander": { "checks": ["pnpm check"], "push": "origin" }`; both are optional.
Each attempt starts from a reset checkout, and the integrated commit is memoized after the checks, so a crash resumes
safely. Failed submissions are dropped from the queue after their report.

Top-level mains use `workspace status`, `workspace submit` and `workspace land` for their own checkout.
Own tool landing skips the calling conversation's run and inbox checks; UI landing does not.
Landing reports commits and changed paths, with a restart hint for core changes to the running clone.
The Workspaces panel shows the lander queue, Submit and Land per checkout, and Remove landed.
Archive and clear context never remove a checkout. Landing never restarts Ultimate.
