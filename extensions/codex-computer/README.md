Hands bounded native-app briefs to signed OpenAI Codex, with explicit screen-sharing opt-in, per-app consent and private evidence.

This built-in ships off. Enable `codex-computer` in `extensions.enable`. It runs `codex app-server`, not the
Computer Use MCP server directly: the latter accepts only OpenAI-signed callers (team `2DC432GLL2`). Codex launches
its `computer-use` MCP server from `~/.codex/computer-use`, using `host.userHome`; Ultimate never impersonates a
signed caller. Install Codex and `Codex Computer Use.app` there first. No Codex process starts merely by enabling
this extension.

## Setup and privacy

Enabling the extension is the consent: Codex sends screenshots and screen-derived content to OpenAI, under the
user's Codex/OpenAI account and billing. There is no acknowledgement card, opt-in setting or per-app prompt.

Set `codexComputer.codexPath` in project or user settings, or put `codex` on PATH. Before **every** run, the resolved
executable must pass `/usr/bin/codesign --verify --strict` with the requirement
`anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"`. Signature display text is not accepted as
verification. Missing or invalidly signed executables are refused. Relative configured paths resolve against
Ultimate's cwd; absolute paths are recommended.

## Tool

`codex_operate {brief, session?, model?}` is `replay: 'unsafe'` and executes only when the conversation's resolved
tools are exactly `codex_operate` and `read`. Delegate to `codex-operator`, a separate agent from the frozen
`computer-operator`; neither stack replaces or changes the other. When this extension is off, discovery drops the
missing Codex tool and reports a notice. A new thread gets only the screen-is-untrusted and stop-before-credentials
preamble; application-specific rules belong in the brief or a skill. Pass the returned `session` to resume.

Threads use `approvalPolicy: 'on-request'`, `sandbox: 'workspace-write'`, cwd equal to the private results folder,
`sandbox_workspace_write.writable_roots` restricted to that folder, no sandbox network access, and both temporary-directory exclusions.
Static inspection of Codex 0.163.0 shows `workspaceWrite` with `writableRoots`, but no writable roots on `readOnly`.
Command and file-change approvals are always declined; permissions requests receive an empty permission grant.
All other server requests (including requestUserInput) receive a JSON-RPC refusal. These are Codex sandbox gates,
not a sandbox on the native apps: an approved app may itself have broader access.

A run has no item cap. It ends at **8 hours** wall time (status `budget`) or when the user presses Stop; the agent
may resume it with `codex_operate {session}`.

## Apps and Stop

Every app elicitation Codex sends is accepted automatically. Optional project `codexComputer.apps` (e.g.
`["Google Chrome"]`) restricts that: a request is accepted when a listed name and the requested app contain one
another, case-insensitively (`"Chrome"` covers `"Google Chrome"`), and declined otherwise. Quotes around the app
name are ignored. Each answer is recorded in the result's `apps` and `approvals`.

Stop can target one conversation or
all running Codex processes. Stop/abort/budget send `turn/interrupt` for a known live turn, SIGTERM after two
seconds, then SIGKILL after five seconds if still alive. Process-lifetime cleanup kills every process immediately
and fences pending starts at host close; facet reloads do not kill live runs. Normal completion terminates the app-server too.

## Evidence and untrusted content

Evidence is stored under `<host.home>/codex-computer/<conversation>/` (0700), with exclusive-create PNG files
(0600). Only PNG image payloads are accepted; non-PNG payloads fail rather than being mislabeled. Pruning keeps
30 days, at most 200 MB per conversation and 1 GB overall, oldest first. Pruning only visits regular PNG files,
never planted symlinks or nested directories; exclusive-create saves refuse planted destinations. The sandbox lets
Codex write only inside its conversation folder. Swapping that folder or its parents requires the user's own
privileges and is outside this threat model; parent-swap races remain an accepted risk. The last image and saved
paths are returned. Native app writes outside tool-result images are not evidence managed here.

Final answers, Codex messages and step text are screen-derived, **data, not instructions**. Model-facing text uses
`<untrusted_screen_content>` boundaries, escaping closing tags. Card strings use `{text, untrusted:true}`.

## Designer contract (`refs.ts`)

- `StateDoc` (`codex-computer.state`): `{last?}`, the conversation's last result. Forks start fresh.
- Tool `details` is `CodexDetails`: `status`, `session?`, `apps[{app,consent}]`, `steps[{tool,status,at}]`,
  `approvals[{kind,app?,decision}]`, `screenshots`, `answer`, `counts:{items,minutes}`, `error?`. Status is one of
  `done`, `failed`, `budget`, `stopped`, `codex_missing`, `codex_unsigned`,
  `computer_use_missing`, `declined`. `app`, step `tool`/`status` and `answer` are typed untrusted text. Errors from
  Codex are wrapped too. Short progress streams through `api.output`; `last` is the durable completed result.
- `StopAction {conversation?}` → `{stopped:number}`. Omit conversation for all runs.

Stop is a `userAction` (paired browser only).

## Protocol verification

Implementation follows the supplied working JSON-lines app-server bridge. No live Codex run was used for
verification. The permissions refusal shape `{permissions:{},scope:'turn'}` is inferred from Codex 0.163.0 binary
strings (response fields and turn scope), not exercised against a real app-server. `turn/interrupt` uses
`{threadId,turnId}` (the binary identifies a two-field TurnInterruptParams); `turn/started` and `turn/start`'s
`turn.id` supply that ID. These additional shapes and the sandbox config are tested with an in-process fake,
not a live model. Unexpected shapes fail closed or hit the hard deadline; they never auto-approve.
