# Computer use: phase 0 spike results

Run on 2026-10-25 on this Mac: arm64, macOS 26.6.2, a 1800×1169 pt display at 2x. The scripts lived in
`/tmp/cua-spike` (Node 26, `@modelcontextprotocol/sdk` 1.32.2 talking to `cua-driver mcp` over stdio) and were deleted
afterwards. The target was Calculator, launched by the Driver in the background.

## Install

- `CUA_DRIVER_RS_VERSION=0.37.0` pinned through the official installer (`cua.ai/driver/install.sh` → `_install-rust.sh`)
  with `--no-modify-path`. It installed `/Applications/CuaDriver.app` plus a symlink at `~/.local/bin/cua-driver`, and
  touched no shell rc.
- The app is signed with Developer ID team `YCK386LBJ7`, bundle `com.trycua.driver`; `cua-driver doctor` is all ok.
- Telemetry is on by default for new installs. We ran `cua-driver telemetry disable`; the installation ID is kept.
- `cua-driver permissions grant` launched the app through LaunchServices. Both prompts named "Cua Driver". The user
  enabled Accessibility and Screen Recording, and the grant step also verified Tahoe's direct-capture consent.
- Releases are tagged prerelease and ship every few days (0.35.2 → 0.38.0 in eight days). Pinning is required.

## Results

| Question                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Works end to end**                                                  | Yes. AX `click` by `element_token` on All Clear, 6, ×, 7, = in the background; the display read back `6×7 / 42`. Calculator never came to the front and the pointer did not move.                                                                                                                                                                                                                                                                                                      |
| **Latency**                                                           | MCP connect 77–80 ms. `list_apps` 237 ms. AX tree only (33 elements, 2.3k chars ≈ 600 tokens): 116–220 ms, p50 ≈ 125 ms. Window tree plus screenshot: 185 ms warm (511 ms cold). AX click: 555–610 ms each, with or without the agent cursor overlay (the first call ≈1.2 s). `run_steps` of 5 clicks: 3.3–4.2 s, so batching saves almost nothing per action. Desktop capture at the default 1366×887 PNG (≈730 KB): 440–670 ms; at 1024×665 (≈470 KB): 410 ms.                       |
| **Jev latency** (from Ultimate's own `classify.ask` traces, 99 calls) | p50 114 ms, p90 168 ms, max 2.1 s; 0 failures.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Image size defaults**                                               | The Driver's global `max_image_dimension` is 1366. Window captures report `screenshot_scale: 2` and a `capture_id`. A full 1366×887 desktop ≈ 1.6k Claude tokens; 1024×665 ≈ 0.9k.                                                                                                                                                                                                                                                                                                     |
| **Keeping the display awake**                                         | Yes, and more than we want. The daemon holds a `PreventUserIdleDisplaySleep` assertion named "Cua Driver: an agent is working on this Mac" **for its whole lifetime**, not per session or turn. It stayed 13 s+ after the client closed and was still there 3½ minutes later. `cua-driver stop` releases it (verified: no assertion and no daemon afterwards). `CUA_DRIVER_KEEP_DISPLAY_AWAKE` exists in the binary. Consequence: the extension must stop the daemon when idle.        |
| **Held keys after a crash**                                           | None seen. A foreground batch of `press_key` with `shift+option` was killed with SIGKILL mid-batch; 200 ms later the session key state had no modifier or button held (`keystate` probe via `CGEventSource`). The Driver exposes no hold-key tool: every key and drag is press-and-release inside one call, so a stuck key needs the daemon itself to die inside one call. That is narrow, and not tested.                                                                             |
| **Stopping an in-flight batch**                                       | **MCP cancel does not stop it.** Aborting the request returns at once, but the daemon finishes all 15 steps. **Killing the client does not stop it** either (the display kept gaining digits 5 s later). **`end_session` does not stop it**, even from the owning connection (15/15 ok). **`cua-driver stop` does:** it took 129 ms; only 2 of 15 steps landed; the call failed with "Connection closed"; the next `cua-driver mcp` started a fresh daemon with its TCC grants intact. |
| **Reads during a running batch**                                      | Reads from a second connection sometimes return in ~130–170 ms and sometimes wait for the batch. Do not rely on them.                                                                                                                                                                                                                                                                                                                                                                  |
| **The user typing in the same app**                                   | **Tested 2026-10-25 (see below): it is not safe.** No user-intervention detection was found in the Driver: no tool, no refusal code, and none in the binary's strings, unlike omp's `UserIntervened`. Both kinds of background edit disturbed the user's typing in the same app.                                                                                                                                                                                                       |
| **Lock screen**                                                       | The binary refuses input while the screen is locked or the screen saver runs ("macOS hides every app's windows from accessibility and sends input to the lock screen"). Not exercised.                                                                                                                                                                                                                                                                                                 |

## Typing test (the user at the keyboard, TextEdit)

The user typed `1234567890` repeatedly on the middle line of **user-test.txt**, the frontmost window, for about 2
minutes. The agent worked in the same app in the background, in two phases. The log was taken from AX reads around
each step.

| Phase    | Agent action                                                                                                                     | What happened                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (60 s) | Every ~4 s, rewrite the top line of the **same document** by read-modify-write `set_value` of the whole text area (≈550 ms each) | **The user's caret jumped to the end of the document** after the first write: their digits landed after "END OF TEST DOCUMENT" (`…DOCUMENT6=4505906`). They had to click back repeatedly; their line grew only to about 10 digits in 60 s. Each Driver `set_value` also reported "A net-zero key edit (space, backspace) was sent" to mark the document edited: real keystrokes into the user's app. |
| B (60 s) | Every ~4 s, `type_text` "line N " into **agent-test.txt**, another window of the same app, by element token (≈1.2 s each)        | The user's line grew steadily (16 → 78 digits), but **about 25 of the user's digits landed in the agent's window** (`line 1 73line 2 line 3 786line 4 …`), and a few more landed at the end of their own document. Background insertion into another window of the frontmost app briefly diverts the app's keyboard focus.                                                                           |

An earlier attempt was void: the agent's same-document writes were all refused as stale tokens. That run showed that
**every `get_window_state` invalidates the window's earlier element tokens**, so a token must come from the latest
read. The user's first "no issue" report was from a run where the test never started (no digit reached the test
line).

**Consequences for the design:**

- **Never edit text in the app the user is in.** When the target app is frontmost, `type`, `set_value` and `key` are
  refused with `user_active` unless the user granted a foreground takeover for this task. Clicks and presses on other
  windows are allowed. The status line says which app the agent is waiting for. Without Input Monitoring this rule
  uses the frontmost app, not keystrokes; a listen-only detector stays a later decision.
- **Replace a field's value only through that field's element** (never a whole-document read-modify-write), and only
  when the field is not the user's focused element.
- **Tokens come from the latest observation only.** `computer_act` re-reads the window when the model's token is stale
  (refusal `stale_element_token`), maps the token to the same element by role, label and path, and acts only on an
  exact single match. Otherwise it returns the fresh observation.

## What changes in the design

1. **Dispatch steps one at a time from the extension; do not use `run_steps` for multi-step work.** Batching gains
   ≈0.1 s per step, and a running `run_steps` cannot be cancelled. With per-step dispatch, Stop takes effect before the
   next step (≤ one step, ≈0.6 s).
2. **A two-level kill switch.** Stop ends the loop between steps. If a step is still running 1 s later, or the user
   presses Stop again, run `cua-driver stop` (≈130 ms). It kills every Driver session on this Mac, so the card says so.
3. **Daemon lifecycle:** run `cua-driver stop` after 5 minutes without a computer call, so the display can sleep again.
   A new call restarts it in ≈80 ms (plus the first-call cost).
4. **Typed text always targets an `element_token`** (never the focused element), and values are read back after
   `set_value` or `type`. User-intervention detection stays out of phase 1: we show the controlled app on the status
   line and tell the user that typing in it races with the agent. A listen-only check needs Input Monitoring, and it
   is a later decision.
5. **AX-first holds up:** a full Calculator tree costs ≈600 tokens in ≈125 ms, versus ≈0.9–1.6k tokens for a
   screenshot. Combined with Jev at ≈114 ms, a Jev-driven step is ≈0.85 s and makes no frontier-model call.
