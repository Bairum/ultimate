Commits made through `bash` carry an `Ultimate-Conversation: <id>` trailer via process-local Git config hooks; commits outside the tool and repository hook files are untouched.

Pi's coding tools and how the transcript shows them: `read` as a numbered, highlighted excerpt; `write` with its size and content; `edit` as a unified diff with old and new line numbers; `bash` as a terminal with streamed output, exit status, and duration.

Bash calls without `timeout` have a 600-second tripwire ceiling. `ULTIMATE_BASH_TIMEOUT` overrides that default
in seconds and is read at each call; it must be positive and finite. A tripwire timeout stops the process and reports
how to request a longer explicit timeout. Explicit timeouts retain Pi's ordinary timeout error.

Pi's `prepare` hook only changes the command, cwd, and environment, not the timeout, so one wrapper injects the
default and formats execution timeout errors. It retains the default server order (0), installing after the
`exclusive-commands` wrapper (`order = -10`): the default-timeout wrapper runs outside exclusivity, which receives
the effective `args.timeout` and deducts queue time. An execution timeout reports the original default limit even
when exclusivity passed a smaller remaining budget; waiting timeout errors retain the holder and limit.

`server.ts` installs Pi Durable's read, write, edit, and bash tools (named `coding-tools`, like this folder). `web.tsx` registers one renderer per tool name under `tools`; `diff.tsx` turns the edit tool's `details.patch` (or Pi's display `details.diff`) into rows.
