# Faux demo

Development-only scripted responses for `ULTIMATE_FAUX=1`. Inert without `host.faux`. The core supplies Pi's faux provider; this extension supplies the looping shell/edit, codemode, restart and subagent demos and creates `demo.txt` only in the instance home. Without this extension, a caller can queue its own responses on the faux handle; Pi reports an error if its response queue is empty.
