Triage a GitHub repository's open issues and pull requests with the agent docked beside them.

The Triage surface reads through the `gh` CLI (`server.ts` actions `status`, `list`, `show`, `labels`) and shows a setup
screen with the exact command when gh is missing or logged out. The header picks the repository: this project's GitHub
remote by default, or any `owner/repo` (a pasted GitHub URL works); the choice, the issue/PR switch, the label filter,
the search, and the selection are durable UI state.

Summarize, Suggest labels, and Draft a reply hand the selected item to the agent with its repository, number, title,
author, labels, and the `gh` command to read it. The agent never writes to GitHub: a prompt section forbids it, and it
calls `triage_propose` instead. That tool writes nothing; its card in the conversation shows the proposed labels and
reply with Apply, Edit, and Discard, and only that click calls the `label` or `comment` action. Outcomes are remembered
per proposal, and the surface reloads after a write.

Files: `web.tsx` (surface, agent buttons), `list.tsx` (filters, list), `detail.tsx` (item, comments),
`repo-picker.tsx`, `setup.tsx`, `proposal.tsx` (the `triage_propose` card), `types.tsx` (shared types).

Safety: accidental GitHub writes by the agent are blocked at the process level. Wrapped `bash` (also used by
codemode and subagents) prepends a `gh` shim that permits only read commands and blocks `auth token`, and unsets
GitHub token environment variables. Scripts and indirect shell invocations use the same shim. This is not a security
boundary against a deliberately evasive shell (for example, calling `gh` by absolute path or forging browser headers).
The agent proposes with `triage_propose` instead. Extension actions require same-origin browser request headers.
The UI's Apply and Post only write to repositories listed in `githubTriage.writableRepos` in `.ultimate/settings.json`
(here only the private `HazAT/ultimate`); every other repository is read-only.
