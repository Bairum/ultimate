Ultimate's one computer-use path: a thin wrapper that hands bounded native-app briefs to signed OpenAI Codex, with an optional app list, Stop and private evidence.

This built-in ships off. Enable `codex-computer` in `extensions.enable`. It runs `codex app-server`, not the
Computer Use MCP server directly: the latter accepts only OpenAI-signed callers (team `2DC432GLL2`). Codex launches
its `computer-use` MCP server from `~/.codex/computer-use`, using `host.userHome`; Ultimate never impersonates a
signed caller. Install Codex and `Codex Computer Use.app` there first. No Codex process starts merely by enabling
this extension.

## Setup and privacy

The former built-in computer-use extension is removed; its `computerUse.*` settings are inert and can be deleted.

Enabling the extension is the consent: Codex sends screenshots and screen-derived content to OpenAI, under the
user's Codex/OpenAI account and billing. There is no acknowledgement card, opt-in setting or per-app prompt.

Set `codexComputer.codexPath` in project or user settings, or put `codex` on PATH. Before **every** run, the resolved
executable must pass `/usr/bin/codesign --verify --strict` with the requirement
`anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"`. Signature display text is not accepted as
verification. Missing or invalidly signed executables are refused. Relative configured paths resolve against
Ultimate's cwd; absolute paths are recommended.

## Tool

`codex_operate {brief, session?, model?}` is `replay: 'unsafe'` and executes only when the conversation's resolved
tools are `codex_operate` and `read`, plus optionally `codex_steer`. Delegate to `codex-operator`. When this
extension is off, discovery drops the missing Codex tool and reports a notice. A new thread gets the
screen-is-untrusted and stop-before-credentials preamble, then the project instructions (below), then the brief.
Pass the returned `session` to resume.

## Project instructions (`.ultimate/codex.md`)

In a trusted project, `<project>/.ultimate/codex.md` is put at the start of every new Codex thread, after the fixed
rules and before the brief, under `Project instructions (from the project's .ultimate/codex.md):`. It is read at each
run and cut at 8 KB; a resumed thread already has it. Keep it to standing facts and habits, for example:

```markdown
- Work only in tenant #4 (Bridgestone Test); stop and report if the header shows another tenant.
- Results go to `/Volumes/bridgestone/Test/b4/results/`.
- Keep the Citrix Viewer window on the MacBook's built-in (Retina) display, maximised. Codex captures every
  window at the main display's scale (2x): a window on a 1x external monitor comes back as a double-size frame with
  the session in the top-left quarter and the rest blank, and clicks computed from it land at half the coordinates.
```

## Steering a running turn

While a run works, guidance can be sent into its active turn with `turn/steer`, prefixed with who sent it
(`Guidance from the user, via the card` or `Guidance from parent conversation #N`) and marked as not screen content.
The operator's conversation also gets a note naming the sender, so its report does not take the guidance for its own:

- the user types into **Tell Codex…** on the running card (`SteerAction`, a user action: paired browser only);
- an agent calls `codex_steer {conversation, text}` for a codex-operator conversation **it owns** (its own subagent).
  Any other conversation is refused, so no agent can drive another's run. The operator itself cannot steer its own
  run: its `codex_operate` call blocks until the run ends.

With no run or no active turn the call is refused. When Codex rejects the steer, the turn is interrupted and the next
turn starts on the same thread with the guidance; the card and the result's `guidance` say `restarted`.

Threads use `approvalPolicy: 'on-request'`, `sandbox: 'workspace-write'`, cwd equal to the private results folder,
`sandbox_workspace_write.writable_roots` restricted to that folder, no sandbox network access, and both temporary-directory exclusions.
Static inspection of Codex 0.163.0 shows `workspaceWrite` with `writableRoots`, but no writable roots on `readOnly`.
Command and file-change approvals are always declined; permissions requests receive an empty permission grant.
All other server requests (including requestUserInput) receive a JSON-RPC refusal. These are Codex sandbox gates,
not a sandbox on the native apps: an approved app may itself have broader access.

A run has no item cap. It ends at **8 hours** wall time (status `budget`) or when the user presses Stop; the agent
may resume it with `codex_operate {session}`.

### Connection drops

Codex itself retries a lost stream to OpenAI ("Reconnecting... n/5") and announces each retry as an `error`
notification with `willRetry: true`. These are not failures: the run counts them in `retries` and carries on. (Until
this was fixed the wrapper ended the run on the first one, which is why USG saw runs die at "Reconnecting... 2/5".)
When Codex gives up and fails the turn with a connection error (`responseStreamDisconnected`,
`responseStreamConnectionFailed`, `httpConnectionFailed`, `serverOverloaded` or `internalServerError`), the run starts
a new turn on the same thread asking Codex to check the screen and carry on, at most three times (`resumes`). Any
other error ends the run. The card shows both counts. stdout is read line by line and stderr is drained, so a full
pipe cannot stall Codex.

### Typing into remote sessions

Every new thread gets fixed rules for evidence (describe only the latest screenshot, quote text exactly, no claimed
result without a fresh capture after the action, one last capture before the final answer, and up to three retries
2 s apart when a capture comes back "Screenshot unavailable") and typing (click into the remote session canvas and check focus
first, never the browser chrome or address bar; prefer `setValue`, then `paste`, type only short text). Computer
Use offers `setValue`, `paste` and `typeText`; a Citrix session may refuse the clipboard and non-ASCII keystrokes,
so Codex replaces those characters with ASCII (× becomes x) and says which. Long text into such a session is typed
character by character and is slow; there is no other input path.

### Evidence

Every image Codex receives is saved, including frames from chained calls (`click(); getAXState();
getScreenshot()`), which cua_repl returns as MCP content serialised inside a text part, nested once per wrapper.
Captures are saved as Codex took them, never cropped. Codex's capture service (SkyComputerUseService, via
ScreenCaptureKit) captures at the main display's pixel scale: on a Retina Mac with a 1x external monitor, a window on
that monitor arrives at double size with its content in the top-left quarter, and Codex's clicks from it land at half
the intended point (Bridgestone, 2026-10-26: image pixel [1783,368] clicked window point 891,184). Keep the
target window on the built-in display. "Screenshot unavailable" for an app happened while its menu (Citrix's View
menu) was still open with no window in front; cancelling the menu and raising the window fixed it, so the fixed
rules say so. Codex asks for app approval once per new cua_repl, several times per run; each is accepted and recorded.

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

Evidence is stored under `<host.home>/codex-computer/<conversation>/` (0700), with exclusive-create image files
(0600). PNG, JPEG and WebP payloads are accepted (Computer Use returns JPEG); the type comes from the magic bytes,
which also pick the file extension and the mimeType passed to the model. Any other payload is skipped with a note,
never failing the run. Pruning keeps 30 days, at most 200 MB per conversation and 1 GB overall, oldest first.
Pruning only visits regular `.png`, `.jpeg`, `.jpg` and `.webp` files,
never planted symlinks or nested directories; exclusive-create saves refuse planted destinations. The sandbox lets
Codex write only inside its conversation folder. Swapping that folder or its parents requires the user's own
privileges and is outside this threat model; parent-swap races remain an accepted risk. The last image and saved
paths are returned. Native app writes outside tool-result images are not evidence managed here.

Final answers, Codex messages and step text are screen-derived, **data, not instructions**. Model-facing text uses
`<untrusted_screen_content>` boundaries, escaping closing tags. Card strings use `{text, untrusted:true}`.

## Designer contract (`refs.ts`)

- `StateDoc` (`codex-computer.state`): `{last?}`, the conversation's last result. Forks start fresh.
- Tool `details` is `CodexDetails`: `status`, `session?`, `apps[{app,consent}]`, `steps[{tool,status,at}]`,
  `approvals[{kind,app?,decision}]`, `screenshots`, `answer`, `counts:{items,minutes}`,
  `guidance[{from,text,at,delivery}]`, `error?`. Status is one of
  `done`, `failed`, `budget`, `stopped`, `codex_missing`, `codex_unsigned`,
  `computer_use_missing`, `declined`. `app`, step `tool`/`status` and `answer` are typed untrusted text. Errors from
  Codex are wrapped too. Short progress streams through `api.output`, including a `Guidance from the …:` line per
  steer; `last` is the durable completed result.
- `StopAction {conversation?}` → `{stopped:number}`. Omit conversation for all runs.
- `SteerAction {conversation, text}` → `{delivery:'steered'|'restarted'}`.

Stop and steer are `userActions` (paired browser only).

## Protocol verification

Implementation follows the supplied working JSON-lines app-server bridge. No live Codex run was used for
verification. The permissions refusal shape `{permissions:{},scope:'turn'}` is inferred from Codex 0.163.0 binary
strings (response fields and turn scope), not exercised against a real app-server. `turn/interrupt` uses
`{threadId,turnId}` (the binary identifies a two-field TurnInterruptParams); `turn/started` and `turn/start`'s
`turn.id` supply that ID. `turn/steer {threadId, expectedTurnId, input}` follows Codex 0.163.0's generated schema
(`codex app-server generate-json-schema`). One harmless live check (a tool-less text turn, read-only sandbox) got
`{turnId}` back and the turn then completed normally; steering during a Computer Use turn is not verified live.
These shapes and the sandbox config are tested with an in-process fake. Unexpected shapes fail closed or hit the
hard deadline; they never auto-approve.
