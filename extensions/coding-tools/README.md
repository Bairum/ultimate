Commits made through `bash` carry an `Ultimate-Conversation: <id>` trailer via process-local Git config hooks; commits outside the tool and repository hook files are untouched.

Pi's coding tools and how the transcript shows them: `read` as a numbered, highlighted excerpt; `write` with its size and content; `edit` as a unified diff with old and new line numbers; `bash` as a terminal with streamed output, exit status, and duration.

`server.ts` installs Pi Durable's read, write, edit, and bash tools (named `coding-tools`, like this folder). `web.tsx` registers one renderer per tool name under `tools`; `diff.tsx` turns the edit tool's `details.patch` (or Pi's display `details.diff`) into rows.
