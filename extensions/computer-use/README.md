# Computer use

Computer use operates native macOS apps through Cua Driver, with TypeSafe Jev driving routine sub-goals behind user consent and per-step safety gates.

Off by default; phase 1 controls this Mac only. Enable in user or project settings:

```json
{
  "extensions": { "enable": ["computer-use"] },
  "computerUse": {
    "driverVersion": "0.37.0",
    "idleStopMinutes": 5,
    "jev": { "act": 0.8, "margin": 0.25, "done": 0.85, "risk": 0.3, "maxCandidates": 24 }
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

- **`computer_observe {app?, window?, screenshot?, query?, zoom?}`**: replay-safe. Without `app`, list apps; with an app but no window, list its windows. Select a window by id or unique title substring to read its full-output accessibility tree (250 elements, depth 12, 16,000 text characters; truncation is noted). `screenshot` is `auto` (default), `always` or `never`: auto captures only empty/chrome-only trees. Returns the snapshot/capture identity, bounded tree in an `untrusted_screen_content` block, and optional image. `zoom: [x0,y0,x1,y1]` requests a **read-only** crop: pixel actions grounded on zoom images are refused as `zoom_read_only`; observe a full capture first. Images are limited to a 1568-pixel long edge, or 2576 for Claude Opus 4.7+/5.x.
- **`computer_act {app, window?, actions?, goal?, expect?, foreground?}`**: not replay-safe. Exactly one of `actions` or `goal`. Explicit actions are `click`, `double_click`, `right_click`, `type`, `set_value`, `key`, `scroll`, `menu` and `wait`. Target elements by tokens from the latest observation; pixel clicks require `x`, `y` and the latest `capture`. Text always names an element. Driver 0.37.0 has no wait tool: a `wait` step returns `unsupported_step` without dispatch. Steps are sent individually, stopping at the first non-delivered outcome; later steps are `not_run`. `expect` goes through `verify_state`, followed by a fresh tree. Goal mode uses `goal: {text, params?, steps?, done_when?, budget?}`: Jev picks extension-built candidates, verifies effects and returns `done` only when Driver predicates satisfy `done_when`. Otherwise it escalates with a reason. Routine goals default to 8 steps / 30 seconds. On escalation, narrow the goal or act explicitly; do not repeat blindly.
- **`computer_apps {launch?}`**: list apps or launch a consented app in the background. The tool is replay-safe for listing; a durable call-id journal prevents re-sending a launch after interruption (returns `observe_first` instead).

`computer-operator` is the bounded native-app subagent: these three tools plus `read`, without bash or web access. Its brief must name allowed apps and desired evidence.

## Actions and document

All actions return the conversation's session unless noted. Only `state` is available to agents; authority-changing actions are `userActions` reserved for the UI.

| Action     | Arguments                                                                | Effect                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`    | `{conversation}`                                                         | Read session state.                                                                                                                                 |
| `grant`    | `{conversation, app, scope: 'once'\|'conversation'\|'project', always?}` | Grant app consent, clear its consent request, wake the conversation. A once grant is consumed on delivery; deny-listed apps require `always: true`. |
| `deny`     | `{conversation, app}`                                                    | Revoke app consent and takeover; record a denial.                                                                                                   |
| `confirm`  | `{conversation, key}`                                                    | Confirm an exact pending consequential-action key and wake the conversation.                                                                        |
| `takeover` | `{conversation, app}`                                                    | Grant foreground takeover and wake the conversation. The call must also set `foreground: true`.                                                     |
| `release`  | `{conversation, app}`                                                    | Revoke foreground takeover.                                                                                                                         |
| `stop`     | `{conversation}`                                                         | Block dispatch between steps, clear takeovers; kill the daemon after 1 s still in flight, or on a second stop.                                      |
| `hardStop` | `{}`                                                                     | Kill the daemon immediately; returns `{stopped: true}`.                                                                                             |
| `resume`   | `{conversation}`                                                         | Clear stopped and wake the conversation; observe before continuing.                                                                                 |

`computer.session` is per conversation: `grants`, `confirmed` keys, `pending` consent/confirmation requests, the latest 200 `journal` entries, `stopped`, `lastObservedAt`, `takeovers`, and conversation `budget`. Project grants live on conversation 1. Forks start with fresh local authority, journal, takeover and budget; project grants still apply. Takeovers last until stop/release in phase 1; the later task module will also end them when the task ends.

## Safety and recovery

Before every dispatch, ordered gates check stopped → consent/deny list → frontmost app → consequential action → budget. Task gating can later join this chain. Refusals are structured results, not thrown policy errors.

- Password managers, terminals, System Settings, Messages and Mail are deny-listed unless the user explicitly grants `always`.
- Before dispatch, the window PID is resolved with `list_apps`. Use an exact canonical app name or bundle id, case-insensitively: substring aliases return `app_identity`, and grants, denials or takeovers under aliases cannot authorize a canonical target. Both the canonical name and bundle id are checked against the deny list.
- Never edit the app the user is in: `type`, `set_value`, `key` and menu are refused as `user_active` when the target app is frontmost (or focus is unavailable), unless the user granted takeover **and** the call requests foreground delivery. Background clicks remain possible. The Driver has no intervention detector; background text edits can steal the user's caret even in another window of the same app.
- Consequential labels/chords or Jev risk ≥ 0.30 require confirmation of the exact key. Keys bind app, window title, step kind, role, label and ancestor label path, plus a short SHA-256 of the payload; no snapshot token, coordinates or raw payload is stored in the key. This survives a fresh observe. Identical role/label paths share a key: pending requests include the window and label, which confirmation cards must show. Classify cannot override a rule hit; a failed available risk check refuses dispatch.
- Limits are 20 dispatches per call and 60 steps / 15 minutes per conversation. Retries count. Goal budgets may be smaller.
- Each dispatch is journalled `sending` before contacting the Driver, then `delivered`, `refused`, `failed` or `unknown`. Typed text/values are represented only by length; Jev decisions are journalled too. A transport failure cannot prove non-delivery. After `sending`/`unknown`, the next act refuses `observe_first` until a fresh explicit observe acknowledges the uncertain step.
- Every `get_window_state` invalidates earlier tokens. A Driver stale-token refusal permits one re-observation and one retry only when role, label and full parent path match exactly one element. Ambiguity refuses `stale` with the fresh tree.
- Stop is not proof that the in-flight action did not happen. MCP cancellation does not stop the daemon's current action; the second-level daemon kill is deliberately explicit. Observe and verify before deciding what to do next.

No remote targets, sandboxes, clipboard access, secrets typing or task anchor are exposed in phase 1. The UI facet and task gates are separate work.

## Credits and notices

- **Cua Driver**, by **Cua AI, Inc.**, MIT licensed.
- The **jev-use recipe and native role mapping** are adapted from **trycua/cua**, MIT licensed.
- Ideas from **oh-my-pi**, MIT licensed, and **cua-agent**, MIT licensed.

These upstream projects retain their respective copyright and MIT license notices; Ultimate does not bundle the Driver binary.
