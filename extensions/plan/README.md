Keep epics and tasks in a durable conversation ledger, with open work visible in the prompt.

The `plan` tool creates epics (`E1`) and tasks (`E1.1`), updates them, adds timestamped task notes, and reads full plans with `show`. Epic bodies hold Request, Selected approach, Intent, Scope (in/out), binary Acceptance criteria, Implementation, Verification, and Risks. Task descriptions hold Outcome, Scope, Non-goals, Files, Acceptance criteria with a verification command, and Constraints.

`ultimate.plan` is an exported conversation document with rewindable history and `asOf` forks (Pi Durable requires rewindable history for historical forks). Each mutation commits once, with a task-scoped receipt committed alongside the edit and the result saved via `api.memo`; interrupted replays cannot duplicate tasks or notes. Unknown keys, invalid statuses, and fields meant for the other kind of record are errors. Dependencies must name existing tasks. Notes belong to tasks; epic conclusions use `verdict`.

The `plan` section lists non-done epics and their tasks, including dependencies and linked child conversation numbers, without plan bodies. There is no subagent coupling: the coordinator links a child explicitly with `update {key, child}`.
