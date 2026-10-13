Delegate bounded work with `subagent`: `start {agent, task, background?, fork?}`, `message {id, text, steer?}`, `wait {id}`, `stop {id}`, and `list`. Every new child belongs to an independent background anchor. Foreground is a waiting style, not lifetime ownership: foreground start/message and explicit wait return the answer when ready, or yield on queued steering while the child keeps running. Stopping the parent does not stop these children; use `stop {id}` explicitly. Stop cancels the captured current work and existing pending reporters/inputs, even before a child run starts; replay leaves later reuse alone. Undelivered answers steer the current run at its next tool-round boundary, or start a run when the parent is idle. Child IDs are conversation IDs. Definitions are reread on every start; children receive `subagent` and its extension only when their definition explicitly includes `subagent` in `tools`.

## Interruptible waits and delivery

A wait can yield to steering while the child keeps running. It returns status text and the child's ID, not an answer.
Message or stop that ID, or wait again. Follow-ups do not wake waits; steering and other children's answers do.
An answer already completed by the awaited child takes precedence. Only the local wait is cancelled.
Before each request, a reminder lists running children and inputs waiting to start.
Each start or message creates a reporter that delivers its answer once, including after restart.
Foreground, wait, and asynchronous answers include `Returned model: provider/model` from the stored assistant message (or `unknown` when unavailable), not the configured profile or self-report. Asynchronous report prefixes and provenance remain unchanged. Successful tool answers carry `details.answerId`; completed codemode scripts list these in `details.subagentAnswers`.
The backend removes queued reports already returned by those tools. Failed or yielded scripts leave reports queued.
Reports already sent to the model stay there. An explicit `wait` can still return an earlier answer.

Definitions are Markdown with YAML frontmatter, parsed by Pi's `parseFrontmatter`: required `name` and `description`, optional `isolate` (`none` or `worktree`), `model` (Pi's `resolveCliModel` accepts `provider/id`, fuzzy id or name, and a `:thinking` suffix; unknown models are errors and custom models must be registered in Pi's `models.json`), `thinking` (a Pi thinking level), and `tools` (a YAML list, `[read, bash]` or one `- item` per line); other fields are errors. An explicit `thinking` field overrides the model suffix. The body is the instructions. `agents.ts` reads them from three directories, later overriding by name: `agents/` in Ultimate's clone, `~/.ultimate/agents/`, and the project root's `.ultimate/agents/` (not a conversation's cwd). Omitted tools inherit the parent's tools minus `subagent` and exclude the subagents extension. Explicit tools must remain a subset of the parent's tools; `[read, bash, subagent]` opts into bounded child delegation. Delegating children follow their assigned role, not the root coordinator's epic/worker flow. Each parent owns only its direct children, and forked children start with a fresh child index. The existing definition editor's tools checklist includes `subagent`. Tool restrictions select tools, not a shell sandbox: read-only agents' bash restrictions are instructions. An edited definition is not a code change, so it does not change the build id.

## Attributed transcript messages

The `pi.user` renderer leaves ordinary human input to core. Agent instructions and asynchronous reports use compact Markdown cards with a bot marker, sender conversation ID, and a Source button. Long messages have a scrollable compact view and an explicit expansion control. Successful foreground answers still use the existing `SubagentCall` / `MessageResponse` renderer; their Open button now targets the answer when available.

The `provenance {entries: number[]}` action verifies requested entries against fork-aware history, then joins reporter tasks to durable input/report submissions by their request IDs. It batches history and reporter scans, scoped to the stored entry owners and their creating parents, rather than scanning per row. No message text determines attribution. Known report framing is stripped only after this join. New reporters retain the calling assistant entry for instruction-source navigation; older instructions still link to their true sender, without an entry target. Answer reports retain their original answer target through forks, resets and reopen. If an entry is no longer in the source's active transcript, Source still opens that conversation without scrolling to a different entry.

Source and foreground Open offer a header Return button back to the receiving conversation and its message when known. Transcript entry anchors and the core `ultimate:reveal-entry {conversationId, entryId}` web event cancel auto-follow before revealing a row, so a long answer cannot pull the view back to its end. This one-hop navigation is local to the browser session; ordinary conversation switching remains unchanged. Missing sender summaries keep the ID visible and disable Source with an explanatory tooltip.

### Token-free screenshot fixture

From this checkout, run:

```sh
AGENT_MESSAGES_PREVIEW_MS=120000 AGENT_MESSAGES_SCREENSHOT=/tmp/agent-report.png \
  pnpm exec vp test test/subagents-messages-browser.test.ts
```

Wait for `Agent message preview: http://127.0.0.1:<port>` and open that URL while the test pauses. It uses an isolated temporary home and faux responses, not provider tokens. Scroll up to the first report card if the new browser opens at the transcript's end. The receiving transcript includes a long report with bold, lists, a checked task and a TypeScript block, plus human text resembling a report prefix. Click Source to jump to the child's answer (the parent's Markdown instruction is above it), then Return to restore the receiving report. Use Expand full message / Compact view to compare density. The test also saves the screenshot at the supplied path and closes its server after the pause. Omit both environment variables for the normal automated regression.

For a smaller standalone preview, start a faux instance, accept its project setup, send `delegate to scout`, and use the foreground card's Open button to inspect the attributed child instruction. The rich report fixture above is independent of any user/project agent profile overrides.

## Queued agent inputs

Above the composer, actual pending instructions and reports use quiet bordered rows: sender, instruction/report, steer/follow-up, a truncated preview with full text in its tooltip, Source, and the existing cancellation button. Human lookalikes remain ordinary queue rows. The `provenance {submissions: number[]}` action intersects requested IDs with the receiving conversation's live inbox, then joins the same durable reporter submissions as transcript attribution. Delivered or cancelled submissions cannot be attributed as pending. Source uses the same one-hop Return navigation, returning to the receiving conversation without a transcript entry target.

For a paused, token-free renderer fixture (including a human lookalike and unavailable source), run:

```sh
AGENT_INBOX_PREVIEW_MS=120000 pnpm exec vp test test/subagents-renderer-browser.test.ts
```

Open the printed `Agent inbox preview` URL, including `?inbox=1`, before the pause ends. This standalone fixture supplies deterministic browser data rather than provider runs. Resize to 360px to inspect wrapping and scroll the queue to see the unavailable-source row. `AGENT_INBOX_SCREENSHOT=/tmp/agent-inbox.png` optionally saves the test browser's narrow screenshot. The automated test drives source/return and cancellation; the durable subagent tests separately verify real queued submission identities and cancellation.

## Definitions are shared profiles

A definition is the profile both subagents and automations run with: one helper, `createChild` (`children.ts`) with `definitionAgent` (`agents.ts`), turns it into a child's agent configuration for `start` and for an automation that names it. Edit one in the Agents tab or as its file; both are the same Markdown, and Ultimate changes one when asked by editing that file (codemode's `ultimate.agents()` lists every definition with its source, path, and fields). Built-ins in the clone are never written: saving one writes an override with the same name to the project's `.ultimate/agents/` (shared with the team, and only once the project's setup is local) or to `~/.ultimate/agents/`. Deleting an override makes the definition it shadowed apply again.

Click a definition in the Agents tab, or New, for its config view: description, model (picked from the models extension's catalogue, or inherited from the main conversation), thinking (the levels that model supports, or inherited), tools (a checklist of the main conversation's tools, or all of them), isolate, and the instructions as Markdown with a preview and the saved file. The header shows its source and path, the footer where Save writes and whether that overrides or is shadowed by another file. Duplicate starts a new definition from the shown one. Save writes nothing when the result fails to parse, and shows why inline; files that fail to parse stay listed with their errors and open with the error above the form. Another extension opens a definition's config over the web bus with `events.emit('subagents:open-definition', { name })` (`''` for a new one); `subagents:definition-closed { name }` follows when that dialog closes, so the opener can refetch and take focus back.

## Coordinator flow

The extension's prompt section makes the parent the coordinator; without this extension, that steering is absent. Do quick fixes and simple questions directly. For substantive work, inspect the code, recommend one approach, and ask only for decisions affecting behaviour or scope. Use the `plan` tool to write an epic with binary acceptance criteria and one self-contained task per unit of work; link children and record dependencies and status.

Delegate implementation to `worker` in worktree isolates and bounded reconnaissance to `scout`. Use background children for independent work; children touching the same files run sequentially. Read reports, inspect diffs, and rerun meaningful checks before landing. After checking the combined tip, an isolated main uses `workspace land` to reach its source branch. Restart required Ultimate core changes only when authorized. Discard clean isolates only when requested. Record evidence yourself; a child's report is not your verification.

When all tasks are done, follow the repository's review team and sequencing instructions. If none are defined, run definitions whose names start with `reviewer` in parallel. Use the same explicit immutable `base..head` commit range, never merely a directory. Merge and verify findings yourself, route confirmed fixes back by message or a new task, and verify, land, and review fixes. Post the epic verdict and report to the user. Never delegate judgment. Heavy commands are serialized by `exclusive-commands`; do not bypass it. Children never push; the coordinator never pushes, merges to remotes, or ships unless asked.

### Add another reviewer

Copy `agents/reviewer.md` to `~/.ultimate/agents/reviewer-second.md`, keep its read-only contract and tools, change `name` to `reviewer-second`, and add `model: provider/model-id` using an available registered model different from the parent's. The shipped `reviewer` inherits the parent's model; absent repository-specific sequencing, the `reviewer*` naming convention includes both in the parallel review. Definitions are reread on every start; no restart is needed.

## History forks

`start {agent, task, fork: true}` gives the child the parent's visible history up to the entry before the assistant message containing this call, excluding the pending call itself. The task text is still the child's first new input. Foreground/background waiting style, independent ownership, definition instructions, model, thinking, tools (`subagent` and its extension only with explicit definition opt-in, still subject to the parent tool subset), and isolates work exactly as for a fresh child.

A fork sends the parent's context and therefore costs more than a fresh child; the prompt cache usually covers the shared prefix. Conversation documents follow their declared fork policy: `pi.agent`, `codemode.store`, and `ultimate.ui` copy `asOf` the fork entry; `ultimate.subagents`, `ultimate.metadata`, `models.login`, and Pi's inbox, live state and usage start `initial`. No built-in conversation document uses `current`. The child agent configuration is then replaced with the current parent's configuration and definition overrides; metadata is set to the child's name/task. The child's `ultimate.ui` copy is left as-is: the web reads only the root conversation's UI document, so the unused child copy cannot affect the Agents tab. Its Subagents index starts empty. Codemode's stored values remain available as of the fork point.

## Isolates

An isolate is where a child's tools run, separate from the parent. The workspaces extension owns its checkout and its record in the root `ultimate.workspaces` document. There are no sandboxes, containers or remote machines.

`start {agent, task, isolate?: "none" | "worktree"}` overrides the definition's isolate. The default is none (the parent directory); the shipped worker uses worktree. Preparation creates `<home>/worktrees/<child id>` from the parent's committed HEAD. The child's cwd and instructions point there; its first request waits for setup. The child and checkout are reused on replay.

Optional project `.ultimate/settings.json` configuration:

```json
{ "isolates": { "worktree": { "setup": ["pnpm install --frozen-lockfile --prefer-offline"] } } }
```

Commands run in order with `sh -c`, closed stdin and a two-minute timeout. `ULTIMATE_SOURCE` is the parent checkout path. Interrupted setup repeats, so commands must be safe to repeat. Failure keeps the output tail and removes only a clean checkout; dirty output stays. Failed or removed workspaces block tool calls with an explanation, which the child's answer can report to its parent.

Verify the child's commits, then `land {id}` fast-forwards its saved source branch. Both checkouts must be clean, and the child must have no live run or queued input. If the target changed or diverged, update the workspace onto it and verify again; landing never rebases or pushes. An integrated tip is a no-op. Results list commits and paths and report whether the running Ultimate clone needs restart. `discard {id}` removes only a clean, idle checkout and keeps its branch. See [workspaces](../workspaces/README.md).

Isolation is by working directory, not a sandbox: absolute paths can still reach other checkouts. Children are instructed to work only in their isolate, commit clearly, and never push. There are no remote operations or cross-process landing locks.

The shipped definitions inherit the active provider/model. No universally cheaper model is known across providers, so no model is hardcoded. Override locally to select an available fast model.

The extension document `ultimate.subagents` holds the ownership/action index. Each child gets the core's `ultimate.metadata` (`host.metadata`) with `label` set to its definition's name and `title` to its task, which the shell's header, breadcrumb, and window title show. Reporter request IDs and answer receipts prevent duplicate delivery across restarts; stop records its target run so a replay cannot abort a later run. The action `definitions` returns the definitions (without instructions), the files that failed to parse with their errors, the main conversation's model, thinking level and tools, the user and project folders, and whether the project's setup is local. `definition {name}` returns the definition that applies, its source, path and raw file, the scopes with a file of that name, and a later file of that name that fails to parse. `saveDefinition {name, scope: "project" | "user", frontmatter: {description, model?, thinking?, tools?, isolate?}, instructions, create?}` validates the file as discovery reads it and writes it atomically (`create` refuses an existing name); `deleteDefinition {name, scope}` removes a user or project file.

`web.tsx` renders each `subagent` call (agent, task or message, the child's workspace branch and state from the root workspace document, whether the child is working, its answer, and "open #id" to show the child; the result's details say whether the child is in the background) and adds the right panel's Agents tab: main and its subagents as a tree with working marks and, while a background child works, its `bg` mark from the owner task in the task graph. A child with an isolate shows its state (as in the Workspaces panel) and commits ahead in its row, and below it the checkout with Land and Remove, which call the `workspaces` actions and are disabled while the child runs; Remove asks first, and errors, landing results, and a needed restart show inline. Isolates refetch when the child or parent settles, when the window regains focus, and, while the parent is the shown conversation, as soon as the root workspace document records preparation, land or discard, also one by the `subagent` tool. Below the tree come the definitions with their model and thinking level, and invalid files with their errors, refetched when the window regains focus and when the config dialog closes; each opens its config view (`definitions.tsx`, `fields.tsx`). Showing a child makes the composer steer, follow up, and stop that child; the header leads back to main.
