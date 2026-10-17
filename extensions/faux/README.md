# Faux demo

Send `questions demo` to preview the questions card: a yes/no question and a choice with a recommendation.
With no explicit summary-model setting, faux instances resolve it to `faux/faux-1`; scripted assessment and extraction responses exercise
the same durable flow as real replies, without external model calls.

Development-only scripted responses for `ULTIMATE_FAUX=1`. Inert without `host.faux`. The core supplies Pi's faux provider; this extension supplies the looping shell/edit, codemode, restart, subagent, `submit workspace` (a `workspace submit` call), `leave a note` (a `note` to the root), `notify <id>` / `notify <id> quietly` (a `notify` call), `phases demo` (a slower explore, edit, test and commit sequence for previewing working states) and `fail demo` (a provider error that fails the run) demos, answers lineage's conversion and compaction requests with a short distillation, and creates `demo.txt` only in the instance home. Without this extension, a caller can queue its own responses on the faux handle; Pi reports an error if its response queue is empty.
