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

The Workspaces panel shows the lander queue, statistics over every checkout, and the shown conversation's checkout.
`info {id}` reads the record and current tips; `create {cwd?, title?}` returns a new conversation ID.
`land {id}` fast-forwards the saved source branch to the clean, verified workspace tip.
The workspace must be clean; another running conversation or queued input prevents landing.
Unrelated dirty files in the source checkout do not block; `git merge --ff-only` refuses only real overlap.
If the target changed or diverged, update the workspace onto it and verify again; landing never rebases or pushes.
`discard {id}` removes a clean checkout and keeps its branch and history.
`stats` counts checkouts by state, ready ones by commits (landed on the target, ahead, none yet) and uncommitted
changes; `disk` measures the worktrees directory with `du`, and on btrfs also the real size with shared blocks counted
once (`btrfs filesystem du`). Measuring takes seconds, so one runs at a time and its result is reused for a minute.

## Lander

`workspace submit` (and the `submit {id}` action) queues a top-level main's clean tip in the root document's `queue`
and returns its position and lander conversation at once; the main keeps working. One `workspaces.lander` task per
source checkout (`landers`) processes that source's entries in order; merging, checks, fast-forward and push are
code, and a model runs only on a failure or when someone writes to the lander.

The task runs in that source's lander conversation (`landerConversations`): ownerless, titled "Lander · <target>",
labelled `lander`, its cwd the lander checkout. The project's checkout has one from the moment the extension opens
(idempotently, the same record submit uses); another source gets its own on its first submit. It has no workspace and
is no main, so `workspace submit` and `land` refuse it. The task is its conversation's foreground work, so the Agents
tab and the Canvas show it working while it lands; the Canvas shows it only then. The sidebar pins every lander
conversation above the others, never archived, with "idle · last <sha> <time>", a pulsing "landing", or "fixing" /
"diagnosing" while its model works on a failure. It logs
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
With lineage enabled, the report phase also leaves a replay-safe landing note in the project's root, unless the
submitter is that root. Failed submissions leave no root note; notes never wake the root.

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

Settings (`.ultimate/settings.json`): `"lander": { "checks": ["pnpm check", "pnpm test:all"], "push": "origin" }`; both are optional.

### The lander's model

The lander conversation is configured from the effective agent definition named `lander` (built-in
`agents/lander.md`, overridable in `~/.ultimate/agents/` or the project's `.ultimate/agents/`, editable in the Agents
tab): its model (else the main conversation's), thinking, tools (minus `workspace`) and instructions. Opening applies
it to every lander conversation, and so does any change to a definition folder, so the next message or failure uses
the definition as it is now. Its composer works like any conversation's: ask it what landed or why #12 failed. A
`lander_state` prompt section, only in lander conversations, lists that source's queue (submission id, #N, tip, state, step) and
its latest results (outcome, sha, push, reason).

`onFailure: diagnose | fix` (default `diagnose`) decides what happens on a merge conflict or a check that failed
twice. The checkout stays as it failed (a merge in progress, or the merged commit), the queue entry's `agent` and step
read `fixing` or `diagnosing`, and the task submits a prompt with the reason, output and mode to the lander
conversation (request `lander-agent:<submission>:<attempt>`, placed as an `ultimate.lander-ask` entry) and waits for
it to settle; a resume waits for the same run.

- diagnose: the checkout is reset and the submission fails with the model's answer as `diagnosis`, shown on the
  outcome cards and appended to the report as "Diagnosis by lander".
- fix: the checkout must be clean, without a merge in progress, with new commits on top of the failed merge. Then the
  next attempt starts from that commit and runs every check again; landing reports "Fixed by lander" with the
  model's commits (`fixed`). Anything else, or a fix that still fails, is reported as not landed. A submission gets
  one fix.

Without a `lander` definition, failures are reported as before.
Each attempt starts from a reset checkout, and the integrated commit is memoized after the checks, so a crash resumes
safely. Failed submissions are dropped from the queue after their report.

The fast-forward records `landed: { sha, base, commits, paths, flaky }` on the queue entry in the same commit as the
workspace's `landed`. A lander task that ends after that and before its report, for example one faulted because a
reload of this extension changed the Workspaces document, loses its memos but not that record: whichever task picks
the entry next skips merging and checks, pushes exactly `landed.sha` when the target still contains it, and reports
the original landing. "Nothing new to land" means the tip was already in the target before this submission.

The extension restarts a lander for every source whose queue holds submissions while its task is missing or ended:
when the harness opens, on each reload of the extension, and at once when a task of the previous code faults. A fault
of the current code's own task waits for the next submit or open, so a deterministic fault does not loop.

Top-level mains use `workspace status`, `workspace submit` and `workspace land` for their own checkout.
Own tool landing skips the calling conversation's run and inbox checks; UI landing does not.
Landing reports commits and changed paths, with a restart hint for core changes to the running clone.
The shown conversation's checkout card has Submit, Land and Remove.
Archive and clear context never remove a checkout. Landing never restarts Ultimate.
