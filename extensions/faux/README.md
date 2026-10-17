# Faux demo

Send `questions demo` to preview the questions card: a yes/no question and a choice with a recommendation.
Send `messages demo` to send the user a one-way update and a question, or `message #<id>` (optionally `one-way`)
to message another conversation, previewing the outgoing message cards.
Under faux, summaries run on scripted neutral responses unless `summaryModel` is set. Their title and Ask line
come from the latest user prompt, with generic demo summary, feature and activity text (a prompt containing `no feature` leaves the feature unset, to
preview a conversation shown by its title); only the questions demo
reply is assessed as needing input. The default model is `faux/faux-1`, so assessment and extraction exercise the
same durable flow as real replies without external model calls.

Onboarding is scripted too: `onboarding.start` greets and shows applicable extensions, project and git `setup` cards,
one at a time. Each `onboarding.choice` advances it; after the last it calls `read` on the project's README, then
`seed_tally` with a canned summary including the user's instructions, and asks **What should we do first?** A subsequent
Board post to @ultimate calls `branch` in shared mode (so the demo also works without Git). The demo does not initialize
Git or invent project-specific integrations; the real agent's instructions cover those judgment calls.

Development-only scripted responses for `ULTIMATE_FAUX=1`. Inert without `host.faux`. The core supplies Pi's faux provider; this extension supplies the looping shell/edit, codemode, restart, subagent, `submit workspace` (a `workspace submit` call), `leave a note` (a `note` to the root), `notify <id>` / `notify <id> quietly` (a `notify` call), `phases demo` (a slower explore, edit, test and commit sequence for previewing working states) and `fail demo` (a provider error that fails the run) demos, answers lineage's compaction requests with a short distillation, and creates `demo.txt` only in the instance home. Without this extension, a caller can queue its own responses on the faux handle; Pi reports an error if its response queue is empty.
