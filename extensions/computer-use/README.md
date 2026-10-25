# Computer use

Computer use operates native macOS apps through Cua Driver, with TypeSafe Jev driving routine sub-goals behind user consent and per-step safety gates.

Off by default; controls this Mac only, including pixel-only remote desktops shown locally. Enable in user or project settings:

```json
{
  "extensions": { "enable": ["computer-use"] },
  "computerUse": {
    "driverVersion": "0.37.0",
    "idleStopMinutes": 5,
    "jev": { "act": 0.8, "margin": 0.25, "done": 0.85, "risk": 0.3, "maxCandidates": 24 },
    "pixel": {
      "requireLabel": true,
      "labelRadius": 12,
      "minConfidence": 0.5,
      "settleMs": 3000,
      "maxWaitSeconds": 120,
      "foregroundForDegraded": "takeover",
      "clipboard": false,
      "fileTransfer": false
    }
  }
}
```

Project settings override user settings. `classify` is optional: explicit actions work without it; goal mode escalates `jev_unavailable`. When available, classify sends on-screen labels (not pixels or planner parameter values) to TypeSafe for decisions and risk checks. Add `TYPESAFE_API_KEY` through the Secrets panel for classify, not to settings.

## Setup

Install the pinned Driver:

```sh
CUA_DRIVER_RS_VERSION=0.37.0 bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
cua-driver permissions grant
cua-driver doctor
```

Grant macOS Accessibility and Screen Recording to **CuaDriver.app**, not Ultimate or the terminal. The Mac must be awake and unlocked; a locked screen returns `screen_locked`, not an actionable snapshot. Missing or mismatched Driver versions return `setup` with the exact install command. The Driver's installer enables telemetry by default; `cua-driver telemetry disable` disables it.

One lazy MCP stdio connection is shared per host. The daemon holds a display-awake assertion, so the extension runs `cua-driver stop` after five idle minutes and stops/closes it at host shutdown. This stop affects every Driver session on the Mac.

## Tools

- **`computer_task`**: not replay-safe. Start with `{action: 'start', spec: {id, intent, goal, criteria, scope, stop?, link?}}`, copying the user's words verbatim into `intent`. Criteria have `{id, text, check: Predicate[] | 'evidence'}`; scope has `{apps, params, actions, consequential}`. Stop defaults to 60 steps / 15 minutes / 6 escalations. Ambiguous specs return `awaiting_confirmation` with reasons and a pending task confirmation. Set `{action: 'subgoals', list: [{id, text}]}`, then `{action: 'activate', id}`: one sub-goal at a time. `{action: 'checkpoint', assessment, recentSteps}` asks optional Jev whether activity is on task and progressing; a negative answer requires `{action: 'replan', reason, subgoals?, criteria?, scope?}`. Removing/changing a criterion or widening scope waits for the user's `confirmChange`. `{action: 'finish', outcome: 'done' | 'partial' | 'blocked', summary}` runs Driver verification in scoped app windows; `done` refuses `criteria_unmet` unless every criterion is met. `{action: 'status'}` returns the redacted task note.
  `intent` must equal a whole user message, sentence or line (whitespace-normalised), or one from the parent's `subagents.instruction` brief. Extension wakes and notes cannot supply intent.
  Start creates an active `S1` from the goal text; an explicit nonempty sub-goal list replaces it and activates its first pending entry. Replans and approved changes keep that active-sub-goal invariant. Finish evidence belongs to the active sub-goal, or the most recently completed one.

- **`computer_observe {app?, window?, screenshot?, query?, zoom?, evidence?}`**: replay-safe. Without `app`, list apps; with an app but no window, list its windows. Select a window by id or unique title substring to read its full-output accessibility tree (250 elements, depth 12, 16,000 text characters; truncation is noted). `screenshot` is `auto` (default), `always` or `never`: auto captures only empty/chrome-only trees. Returns the snapshot/capture identity, bounded tree in an `untrusted_screen_content` block, and optional image. `evidence: true` keeps a bounded AX excerpt with app, snapshot and call reference on the active sub-goal. `zoom: [x0,y0,x1,y1]` requests a **read-only** crop: pixel actions grounded on zoom images are refused as `zoom_read_only`; observe a full capture first. Images are limited to a 1568-pixel long edge, or 2576 for Claude Opus 4.7+/5.x.
- **`computer_act {app, window?, actions?, goal?, expect?, foreground?}`**: not replay-safe. Exactly one of `actions` or `goal`. Explicit actions are `click`, `double_click`, `right_click`, `type`, `set_value`, `key`, `scroll`, `menu` and `wait`. Target elements by tokens from the latest observation; pixel clicks require `x`, `y`, the latest `capture` and `expect_label` by default. Text always names an element. `wait {until: {text?, gone?, stable?}, seconds}` polls captures and OCR (or native tree text), is cancellable, and returns a `wait` outcome with `satisfied` or `timeout` and what was seen. Seconds is at most 120 (or the lower configured maximum); waits over 60 seconds hold `caffeinate -d -w <pid>` only while running. Steps stop at the first non-delivered outcome or wait timeout; later steps are `not_run`. Native `expect` predicates go through `verify_state`. OCR predicates can be included as `[{ocr: {appears?: string[], disappears?: string[]}}]` or as the single object `{ocr: ...}`; they use a fresh capture. Goal mode uses `goal: {text, params?, steps?, done_when?, budget?}`: Jev picks extension-built candidates, verifies effects and returns `done` only when Driver predicates satisfy `done_when`. Otherwise it escalates with a reason. Routine goals default to 8 steps / 30 seconds. On escalation, narrow the goal or act explicitly; do not repeat blindly.
  `subgoal?: string` defaults to the active sub-goal. Each delivered explicit step gets a fresh observation; later tokens in the same batch are remapped only by a unique role/label path from that batch's initial observation.
- **`computer_apps {launch?}`**: list apps or launch a consented app in the background. The tool is replay-safe for listing; a durable call-id journal prevents re-sending a launch after interruption (returns `observe_first` instead).
  Launching also requires an active task and an app in its scope; listing remains read-only without a task.

`computer-operator` is the bounded native-app subagent: these four tools plus `read`, without bash or web access. Execution checks the definition name and all three resolved tool sets (offered, callable and deferred). Its brief must include the user's verbatim intent, allowed apps and desired evidence. Every tool result ends with a redacted task anchor; each input while active gets a `computer.note`, never a changing system prompt.

Every tool result also carries `details` for cards (`ComputerDetails` in `refs.ts`), without changing `output` or `structuredOutput`. `details.task` is the structured task footer or null. `details.act` contains mode, per-step outcomes and effective labels (never input payloads), escalation reason, redacted Jev decisions and verification verdict. Step roles/labels and `decisions[].top[].label` are `UntrustedText` (`{text, untrusted:true}`). `details.observe` contains app/window/snapshot/capture metadata, explicitly untrusted title/tree text, truncation and the zero-based image block index in `output`. All `details.summary` values, including task/apps and read-only listings, are wrapped as `{value, untrusted:true}`. Details redact task parameters and current action/goal values; cards must not parse model text or the anchor line.

Pixel steps add `expectLabel` and `ocrMatch` (`UntrustedText`) to each step's details. Wait steps add `wait: {status: 'satisfied' | 'timeout', seen: UntrustedText[]}`. These are additive renderer inputs; the `.tsx` facet is unchanged.

## Pixel surfaces

Install cua-perception 0.2.1 in the Driver's extension store. It runs locally; its mixed-license archive includes an AGPL-3.0-only detector (accepted for this private local use). OCR generally takes 1.5–2 seconds; the default confidence floor is 0.5, reflecting measured text medians around 0.62–0.68.

Before input, OCR parses the click's own capture. A unique text region must contain the normalized expected label and contain the point or be within `labelRadius` screenshot pixels. Labels normalize case, punctuation, whitespace and invisible direction marks. A mismatch or ambiguity returns `label_mismatch` with explicitly untrusted nearby labels. The Driver's returned coordinate metadata maps action coordinates to OCR screenshot pixels; missing metadata is no hit and still requires confirmation. Verified OCR text supplies consequential checks, confirmation keys and redacted journal labels. Consequential labels still require exact one-shot confirmation; an OCR match is not pre-approval.

Degraded windows still require labels even with `requireLabel: false`. They require user takeover plus `foreground: true` by default; `foregroundForDegraded: 'background'` opts out only of that additional degraded-window rule, not the ordinary frontmost gate. Invisible windows, thumbnail bounds much smaller than the AX root, and captures narrower than 300 pixels with a larger AX frame return `window_not_visible` before OCR/input. Show the window, disable Stage Manager, or obtain foreground takeover and observe again.

After delivered pixel input, two equal small captures (at most 800 pixels) establish stability, bounded by `settleMs`, followed by a fresh capture. Satisfied OCR expectations create server-written PNG evidence and parameter-redacted OCR excerpts linked with the same exact-predicate criterion rules as native verification. Finish rechecks OCR criteria against fresh captures. Evidence lives under `<instance home>/computer-use/<conversation>/`, is pruned on observe/act and writes after 30 days, and each conversation is capped at 200 MB (oldest first). Screen captures remain private local files; only excerpts/details/journal labels redact named parameter values.

`clipboard: false` and `fileTransfer: false` are placeholders, not implemented features. A live supervised teach session must validate clipboard and file-transfer behavior before those features are built.

## Actions and document

All actions return the conversation's session unless noted. Only `state` is available to agents; authority-changing actions are `userActions` reserved for the UI.

| Action          | Arguments                                                                | Effect                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`         | `{conversation}`                                                         | Read session state.                                                                                                                                                            |
| `grant`         | `{conversation, app, scope: 'once'\|'conversation'\|'project', always?}` | Grant app consent, clear its consent request, wake the conversation. A once grant is consumed when sent, even if delivery is unknown; deny-listed apps require `always: true`. |
| `deny`          | `{conversation, app, scope?: 'conversation'\|'project'}`                 | Revoke consent at the selected scope (conversation by default). Project revocations live on conversation 1.                                                                    |
| `confirm`       | `{conversation, key}`                                                    | Authorize one dispatch of the exact pending action; the key survives a fresh observe but is removed when sent.                                                                 |
| `confirmTask`   | `{conversation}`                                                         | Confirm the pending task's intent, criteria and scope; wake the conversation.                                                                                                  |
| `confirmChange` | `{conversation}`                                                         | Approve the pending criteria weakening or scope widening; wake the conversation.                                                                                               |
| `takeover`      | `{conversation, app}`                                                    | Grant foreground takeover and wake the conversation. The call must also set `foreground: true`.                                                                                |
| `release`       | `{conversation, app}`                                                    | Revoke foreground takeover; pause the task, invalidate touched-app evidence, and require user resume plus a fresh observe.                                                     |
| `stop`          | `{conversation}`                                                         | Block dispatch between steps, clear takeovers; kill the daemon after 1 s still in flight, or on a second stop.                                                                 |
| `hardStop`      | `{}`                                                                     | Kill the daemon immediately; returns `{stopped: true}`.                                                                                                                        |
| `resume`        | `{conversation}`                                                         | Clear stopped and wake the conversation; observe before continuing.                                                                                                            |

`computer.session` is per conversation: `task` (spec, sub-goals, ledger, counters, evidence and recovery flags), `grants`, `confirmed` keys, `pending` consent/action/task/change requests, the latest 200 `journal` entries, `stopped`, `lastObservedAt`, `takeovers`, and conversation `budget`. Project grants live on conversation 1. Forks start with fresh task state, local authority, journal, takeover and budget; project grants still apply.

## Safety model

Only conversations configured as `computer-operator` whose resolved tools are exclusively `computer_*` or `read` can call `computer_*` tools. User/project overrides adding bash, browser, codemode or web tools fail closed. The tools remain registered for other agents so parents can delegate to the operator (child tools must be a subset of the parent's stored tools). **Known limitation:** user-only actions are a UI convention, not an authenticated user security boundary. The shared action endpoint accepts arbitrary Origins; another agent with bash/browser access (or another local caller) can forge consent, confirmation, takeover or resume requests. This extension does not fix that endpoint. Keep it off unless you accept this remaining risk.

Before the existing stopped → consent/deny list and canonical PID identity → frontmost app → consequential action → conversation budget chain, task gates require an active task, fresh observation, scoped app/action, no repeated-action loop or outline oscillation, an up-to-date checkpoint and remaining task budget. Canonical identity is checked against scope again before consent at dispatch. Refusals are structured results, not thrown policy errors.

| Task refusal                | Recovery                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `no_task` / `task_<status>` | Start a grounded task, obtain pending user confirmation, or let the user resume a stopped/paused task.      |
| `subgoal_required`          | Activate one sub-goal; `subgoal` on an act defaults to that active id.                                      |
| `observe_first`             | Re-observe after Stop, takeover, interruption or an unknown outcome.                                        |
| `out_of_scope`              | Replan; scope widening needs the user's confirmation.                                                       |
| `loop`                      | Three identical action hashes without verified progress, or six alternating outlines; replan with a reason. |
| `checkpoint_due`            | Checkpoint after 10 steps, 15 without sub-goal completion, or drift.                                        |
| `replan_required`           | Jev found the checkpoint off task or not progressing; explicitly replan.                                    |
| `budget`                    | Task step/time budget or the stricter conversation/call budget is exhausted; report partial.                |
| `criteria_unmet`            | Finish cannot claim done; verify the remaining criteria or report partial/blocked.                          |

Each dispatched step records delivery, verified progress and a post-step outline fingerprint. Satisfied Driver verification records evidence; a verified goal completion can complete its sub-goal. Evidence is never accepted from model arguments. Every goal escalation increments the task counter; its configured limit blocks the task.

- Password managers, terminals, System Settings, Messages and Mail are deny-listed unless the user explicitly grants `always`.
- Before dispatch, the window PID is resolved with `list_apps`. Use an exact canonical app name or bundle id, case-insensitively: substring aliases return `app_identity`, and grants, denials or takeovers under aliases cannot authorize a canonical target. Both the canonical name and bundle id are checked against the deny list.
- Every dispatch checks `list_apps.active` immediately before input, again after the Jev risk call. Missing or ambiguous focus fails closed. All input, including clicks, is refused in the user's frontmost app without takeover plus `foreground: true`. Foreground delivery always requires takeover, even into a background app.
- Consequential labels, unlabelled/no-hit clicks, committing keys (including keypad/newline aliases), multiline typing or Jev risk ≥ 0.30 require one-shot confirmation. Pixel clicks hit-test the deepest AX element using measured capture-to-window ratios; the PNG header must match the reported capture dimensions, and inconsistent axes or a reported scale mismatch over 2% produce no hit and require confirmation. Missing or unsupported image data also produces no hit. An empty own label uses identifier, help, description and bounded child static text together; camelCase/snake_case are split before matching. Keys bind app/window, role/label path, rounded frame and payload hash, never snapshot tokens. Confirmations store `{key, at, task}` and expire after five minutes. Pending requests store the full display payload through 4,000 characters; larger payloads return `payload_too_large` without creating a confirmation. Sensitive-field values (including every `AXSecureTextField`, whatever its label) are masked as `••• (N chars)`, never stored in the pending request or journal. Pixel confirmations include `x,y` in screenshot pixels.
- Limits are 20 dispatches per call and 60 steps / 15 minutes per task/resume session. Retries count. New tasks and user resume reset the conversation budget. Goal budgets may be smaller.
- Each dispatch is journalled `sending` before contacting the Driver, then `delivered`, `refused`, `failed` or `unknown`. Typed text/values are represented only by length; Jev decisions are journalled too. A transport failure cannot prove non-delivery. After `sending`/`unknown`, the next act refuses `observe_first` until a fresh explicit observe acknowledges the uncertain step.
- Every `get_window_state` invalidates earlier tokens. A Driver stale-token refusal permits one re-observation and one retry only when role, label and full parent path match exactly one element. Ambiguity refuses `stale` with the fresh tree.
- Stop is not proof that the in-flight action did not happen. MCP cancellation does not stop the daemon's current action; the second-level daemon kill is deliberately explicit. Observe and verify before deciding what to do next.
- Stop is project-wide (conversation 1), survives forks, blocks reads as well as input, and aborts active calls. Only user resume clears it. A second Stop kills the daemon directly, without starting one. Stop clears unused confirmations across conversations; task start and finish also clear them.
- `computer_task {action:'complete', subgoal}` completes an explicit-mode subgoal with linked Driver evidence. Predicate criteria require exactly matching Driver predicates, regardless of any `criterion` tag. Tags link only `check:'evidence'` criteria and never reset the loop detector. A model-chosen `expect` plus an arbitrary tag cannot prove a predicate criterion or reset loops.

No remote targets, sandboxes, clipboard access or secrets typing are exposed in phase 1. The UI facet is separate work.

## Credits and notices

- **Cua Driver**, by **Cua AI, Inc.**, MIT licensed.
- The **jev-use recipe and native role mapping** are adapted from **trycua/cua**, MIT licensed.
- Ideas from **oh-my-pi**, MIT licensed, and **cua-agent**, MIT licensed.

These upstream projects retain their respective copyright and MIT license notices; Ultimate does not bundle the Driver binary.
