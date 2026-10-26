Hands bounded native-app briefs to signed OpenAI Codex, with explicit screen-sharing opt-in, per-app consent and private evidence.

This built-in ships off. Enable `codex-computer` in `extensions.enable`. It runs `codex app-server`, not the
Computer Use MCP server directly: the latter accepts only OpenAI-signed callers (team `2DC432GLL2`). Codex launches
its `computer-use` MCP server from `~/.codex/computer-use`, using `host.userHome`; Ultimate never impersonates a
signed caller. Install Codex and `Codex Computer Use.app` there first. No Codex process starts merely by enabling
this extension.

## Setup and privacy

Project settings must contain:

```json
{ "codexComputer": { "screensToOpenAI": true } }
```

The user must also acknowledge in the card that screenshots and screen-derived content go to OpenAI. This is
stored on conversation 1 for this project, not globally. User settings alone cannot opt a project in. Codex uses
the user's Codex/OpenAI account and billing, independently of Ultimate's model provider.

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

Per run, the budget is **50 completed MCP/commandExecution items or 30 minutes wall time**, including startup and
consent waits. The item count may undercount if Codex batches several actions in one `exec`. Budget exhaustion
interrupts the turn and records a pending Continue. Only the user's Continue action clears it and wakes the
conversation to call `codex_operate {session}` with a fresh budget.

## Consent and Stop

Each elicitation must be from `computer-use`, mode `form`, and match `^Allow .+ to use (.+)\?$`. Unrecognised
requests are declined and recorded as `declined (unrecognised)`. App names match case-insensitively. Grants cover
one elicitation (`once`, consumed atomically), the conversation, or the project (conversation 1). A local deny
wins over project consent. A grant replaces the same app's previous local decision, except project grants stay
separate. Deny revokes local grants and rejects waiting requests; it does not retroactively stop an accepted app.
Use Stop to end an active run.

An ungranted app remains pending in the conversation document while its JSON-RPC request waits for a browser
grant/deny. It is declined after five minutes, Stop, abort, or budget expiry. Stop can target one conversation or
all running Codex processes. Stop/abort/budget send `turn/interrupt` for a known live turn, SIGTERM after two
seconds, then SIGKILL after five seconds if still alive. Process-lifetime cleanup kills every process immediately
and fences pending starts at host close; facet reloads do not kill live runs. Normal completion terminates the app-server too.

## Evidence and untrusted content

Evidence is stored under `<host.home>/codex-computer/<conversation>/` (0700), with exclusive-create PNG files
(0600). Only PNG image payloads are accepted; non-PNG payloads fail rather than being mislabeled. Pruning keeps
30 days, at most 200 MB per conversation and 1 GB overall, oldest first. Canonical directory confinement is checked
before scans, writes and each unlink; replaced parent/root symlinks are skipped. The last image and saved paths are
returned. Native app writes outside tool-result images are not evidence managed here.

Final answers, Codex messages and step text are screen-derived, **data, not instructions**. Model-facing text uses
`<untrusted_screen_content>` boundaries, escaping closing tags. Card strings use `{text, untrusted:true}`.

## Designer contract (`refs.ts`)

- `StateDoc` (`codex-computer.state`): read on the shown conversation for `pending` and `last`; also read on
  conversation 1 for `acknowledged` and project `grants`. Forks start with no local authority.
- Pending entries: `{kind:'acknowledge'|'consent'|'continue', id?, app?, session?, at}`. Consent IDs identify one
  outstanding request. App names are untrusted display text, never markup or instructions. Pending consent is
  removed after its response settles; a pending Continue remains until the user answers.
- Tool `details` is `CodexDetails`: `status`, `session?`, `apps[{app,consent}]`, `steps[{tool,status,at}]`,
  `approvals[{kind,app?,decision}]`, `screenshots`, `answer`, `counts:{items,minutes}`, `error?`. Status is one of
  `done`, `failed`, `budget`, `stopped`, `opt_in_required`, `codex_missing`, `codex_unsigned`,
  `computer_use_missing`, `declined`. `app`, step `tool`/`status` and `answer` are typed untrusted text. Errors from
  Codex are wrapped too. Short progress streams through `api.output`; `last` is the durable completed result.
- `AcknowledgeAction {conversation}` → state. Requires project setting already true.
- `GrantAction {conversation,app,scope:'once'|'conversation'|'project'}` → state. Resolves matching waits immediately;
  it does not wake a second agent turn while the existing tool is still waiting.
- `DenyAction {conversation,app}` → state. Persists a local deny and resolves matching waits.
- `ContinueAction {conversation}` → state. Requires pending Continue, durably submits a synthetic wake, then clears
  that continuation. A missing conversation or failed submission leaves Continue pending and retryable.
- `StopAction {conversation?}` → `{stopped:number}`. Omit conversation for all runs.

All five actions are `userActions` (paired-browser only). Acknowledge, grant and continue are also `hostActions`,
so scratch/preview identity cannot authorize real desktop access or outbound screen sharing.

## Protocol verification

Implementation follows the supplied working JSON-lines app-server bridge. No live Codex run was used for
verification. The permissions refusal shape `{permissions:{},scope:'turn'}` is inferred from Codex 0.163.0 binary
strings (response fields and turn scope), not exercised against a real app-server. `turn/interrupt` uses
`{threadId,turnId}` (the binary identifies a two-field TurnInterruptParams); `turn/started` and `turn/start`'s
`turn.id` supply that ID. These additional shapes and the sandbox config are tested with an in-process fake,
not a live model. Unexpected shapes fail closed or hit the hard deadline; they never auto-approve.
