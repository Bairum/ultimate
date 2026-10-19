# Faux demo

Send `questions demo` to preview the questions card: a yes/no question and a choice with a recommendation.
In @ultimate's conversation, send `messages demo` to send the user a one-way update and a question, or `message #<id>` or `message @<name>`
(optionally `one-way`) to message another conversation, previewing the outgoing message cards; paste images with it to forward them (`images: 'latest'`).
In @ultimate's conversation, `chat demo` (typed, or posted to @ultimate) runs tools, starts a `landing demo` branch
that reports a landing back, and sends you a one-way update and a question; `ask demo` asks another question. A reply
from another conversation gets a short acknowledgement.
In @ultimate's conversation, `cards demo` produces one of each card its chat folds to one line: it starts a
`landing demo` branch, messages it, calls the `seedCards {from}` action through codemode (messages, a reply, a report,
notes, a catch-up, finished, an abstract, a lander report and a landing note, a @sync move, display only),
then sends you an update and a question, which stay open.
In @sync's conversation in a machine home, `fleet demo` calls `fleet`, which returns a demo fleet under faux
(`extensions/sync/README.md` shows how to start a faux machine home); in a project home it shows only the demo's
`ultimate` project. `sync demo` calls `seedSync` through codemode, which writes a finished backup, a failed backup and
a move here into @sync's conversation, display only.
Under faux, summaries run on scripted neutral responses unless `summaryModel` is set. Their title and Ask line
come from the latest user prompt, with generic demo summary, feature and activity text (a prompt containing `no feature` leaves the feature unset, to
preview a conversation shown by its title); only the questions demo
reply is assessed as needing input. The default model is `faux/faux-1`, so assessment and extraction exercise the
same durable flow as real replies without external model calls.

Onboarding is scripted too: `onboarding.start` greets and shows applicable extensions, project and git `setup` cards,
one at a time. Each `onboarding.choice` advances it; after the last it calls `read` on the project's README, then
`seed_tally` with a canned summary including the user's instructions, and asks **What should we do first?** A subsequent
input to @ultimate calls `branch` in shared mode (so the demo also works without Git). The demo does not initialize
Git or invent project-specific integrations; the real agent's instructions cover those judgment calls.

Development-only scripted responses for `ULTIMATE_FAUX=1`. Inert without `host.faux`. The core supplies Pi's faux provider; this extension supplies the looping shell/edit, codemode, restart, subagent, `submit workspace` (a `workspace submit` call), `leave a note` (a `note` to the root), the `seedLandings {from}` action (five demo landing notes with real-looking shas, features and commit counts in `from`'s root, to preview the Landed section), the `seedEvents {from}` action (durable events about `from` and its root: the root, the branch, five landings and two warning notices, to preview the Activity panel; the landings also reach the root as landing notes), the `seedLanes` action (a team next to @ultimate and the lander: two coordinator branches, one with two workers and a reviewer with two sub-reviewers, the other with one forked worker, with half an hour of their tool and model calls written into `trace.sqlite`, one failing, their `subagents.started` and `board.sent` events written into the event log with past times (exact spawn calls, inferred ones, and messages between them), and one worker still calling every 3 s for an hour, to preview the System surface's Agent Lanes and their hierarchy), the `seedCodemode {conversation}` action (or the prompt `seed codemode`: a run of @ultimate's real codemode calls between bash and read steps, with their summary lines, to preview codemode cards and folded runs), `codemode steps demo` (live codemode calls, read-only, writing and failing, which the faux summary model summarizes), the `seedHistory {conversation, count}` action (about `count` entries, 1000 by default, in turns of a user input, a tool call, its result and a Markdown answer, to preview a long transcript and its scrollback), `notify <id>` / `notify <id> quietly` (a `notify` call), `screenshot <file>.png` (a `screenshot` saved at that path), `phases demo` (a slower explore, edit, test and commit sequence for previewing working states) and `fail demo` (a provider error that fails the run) demos, answers lineage's compaction requests with a short distillation, and creates `demo.txt` only in the instance home. Without this extension, a caller can queue its own responses on the faux handle; Pi reports an error if its response queue is empty.
