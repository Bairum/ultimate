# Computer use: requirements and PRD

## Problem

Ultimate can edit code, run shells and drive a headless Chromium (`extensions/browser`). It cannot operate the rest
of a computer: native apps without APIs, system dialogs, a real logged-in browser, another machine. The user wants
an Ultimate extension that does this through cua, borrowing the best parts of omp and the Pi packages.

## Users and setting

One user (the owner of this machine) and the agents working for them:

- An Apple Silicon Mac (arm64, macOS 26.6, 24 GB RAM, a 3024×1964 Retina display), with Docker installed.
  **About 65 GB of disk is free (85% used).**
- Agents: @ultimate, branch coordinators and subagents, on Claude (`claude-code/*`) and OpenAI (`openai-codex/*`)
  models. TypeSafe Jev is available through `classify` (`TYPESAFE_API_KEY`).
- Ultimate is reached locally and over Tailscale (phone), so a run may be watched and stopped remotely.

## Use cases, in priority order

1. **Automate a native macOS app that has no API.** Examples: change a setting in System Settings, export from
   Preview or Numbers, fill a form in a desktop app, read a value out of an app. The user keeps working meanwhile.
2. **Check native-only behaviour of Ultimate or another app under development.** This covers what headless
   Chromium cannot reach: OS notifications, file pickers, drag from Finder, multi-window, a PWA install, Safari.
   (Plain web UI checks stay on the `browser` extension: it is DOM-aware, headless, cheaper and parallel.)
3. **Operate the real, logged-in browser** for a one-off chore on a site without an API, with explicit consent per
   site.
4. **Do risky or exploratory work in a sandbox**: install and try an app, test an installer, run untrusted
   software, in a disposable Linux container (cheap) or a macOS VM (heavy).
5. **Operate another machine** the user owns (a Mac mini over Tailscale): the same tools, a remote target.
6. **Act cheaply on well-structured screens with Jev**: closed-choice decisions over accessibility candidates,
   plus a risk gate on every consequential step.

## Goals

- G1. One small tool surface that works the same on every target (host, sandbox, remote).
- G2. Prefer accessibility over pixels: act through element tokens when they exist, use screenshots to see and
  verify, and use pixels as the fallback.
- G3. Never steal the user's focus or pointer on the host by default (background delivery), and say so when an
  action needs the foreground.
- G4. Safety is built in: per-app consent, a gate on consequential actions, a visible kill switch, and screen
  content treated as untrusted.
- G5. Durable and honest: a crash or restart never silently repeats an action, and the transcript shows what was
  sent, what was confirmed and what is unknown.
- G6. Model-agnostic: works with any vision model Ultimate runs, and uses Jev where a closed choice is enough.
- G7. The token cost is visible and bounded.
- G8. Upstream-able: one optional extension folder, off by default, with no `server/` changes.

## Non-goals

- Building our own desktop driver (Rust/Swift). We use Cua Driver.
- Replacing the `browser` extension for DOM-level web testing.
- Running cua's Python agent loops, UI-TARS or OmniParser inside Ultimate (no Python sidecar; AGPL parts stay out).
- Video streaming of the screen. Live view means the latest screenshot.
- Unattended operation of banking, payments, password managers or account creation.
- Windows hosts (they would come for free through the Driver, but are untested and out of scope).
- Anthropic's native `computer_toolset_20260801` and OpenAI's `{type:"computer"}` in phase 1. They need provider
  support in `pi-ai` (see the architecture doc).

## Functional requirements

**Targets and setup**

- F1. A target is `host` (this Mac), `remote:<name>` (a machine reached over SSH, typically Tailscale), or
  `sandbox:<name>` (a cua sandbox: a Linux container, later a macOS VM). One `local` host target exists by default.
- F2. Setup detection: the Driver is installed, its version matches the pinned one, and Accessibility and Screen
  Recording are granted to `CuaDriver.app`. Any gap appears as a setup card with the exact fix. No silent installs.
- F3. Sandboxes are created only on an explicit user OK, with the disk and RAM figures shown first. They are
  deleted when their conversation concludes, unless they are pinned.

**Perception**

- F4. `computer_observe` returns, for a window or the desktop: app and window identity, a compact accessibility
  tree with element tokens (bounded, default ≤4k tokens), an optional screenshot scaled to the model's image limits,
  and a `capture_id`.
- F5. Zoom on a region of the last capture at full resolution.
- F6. List apps and windows; launch an app (needs consent).

**Action**

- F7. `computer_act` takes an ordered batch of actions (click, double/right click, type, set value, key, scroll,
  drag, menu, wait) addressed by element token or by pixel plus `capture_id`. It runs them in order, stops at the
  first failure, and reports each one as `delivered`, `refused` (with the Driver's code), `failed`, `not run` or
  `unknown`.
- F8. Pixel coordinates are valid only against the capture they came from. A stale frame is refused and never
  re-mapped.
- F9. After a batch, the tool returns a fresh observation of the target (tree, plus a screenshot when asked) so the
  model verifies. Optional `expect` predicates go through the Driver's `verify_state`.
- F10. Background delivery by default. Foreground delivery (focus or pointer takeover) needs the call to ask for it,
  the setting to allow it, and, on the host, the consent card to have covered it.

**Safety and consent**

- F11. Per-app consent card the first time a conversation touches an app: _Allow once_, _This conversation_,
  _Always in this project_, _Deny_. A deny list (password managers, Keychain Access, Terminal on the host, System
  Settings › Privacy) needs an explicit _Always_, and is refused on hands-off goals.
- F12. A consequential-action gate: sending, submitting, deleting, purchasing, granting permissions, installing,
  and anything that leaves the machine need a confirm card, unless the user's own message authorized that exact
  action. The gate uses label rules, plus Jev's yes/no risk answer when the classifier is available.
- F13. Kill switch: a **Stop** button on the live card and the status line, and ⌘K _Stop computer use_. It cancels
  the in-flight Driver call, releases held input and ends the Driver session within 1 s. Stopping from the phone
  works the same way.
- F14. Typing a secret by name (`{type_secret: "NAME"}`): the server reads it from Ultimate's secrets, it never
  reaches the model or the transcript, and screenshots taken right after are not retained.
- F15. Screen and accessibility text are marked untrusted in the tool result. They never widen consent.

**UI**

- F16. A live tool card per call: target chip, the action list with per-step state, before/after thumbnails,
  delivery mode, a Stop button, and an expandable full-resolution screenshot.
- F17. A status-line item while a target is under control ("Controlling Preview · Stop").
- F18. A **Computer** panel: targets, permission state, the per-app consent list (revocable), the latest live
  screenshot per active target, and this session's token spend on screenshots.

**Durability**

- F19. `computer_observe` and zoom are `replay: 'safe'`. `computer_act` is not. After an interruption the model sees
  `interrupted`, plus the journal of which steps were delivered and which are unknown, and must observe before
  acting again.
- F20. A durable per-conversation document records targets, consents, the last `capture_id` and an action audit
  log (metadata only: no typed text, no screenshots).

**Models**

- F21. Works with any model that accepts images in tool results. Screenshots are scaled per model family (Claude
  ≤1,568 px / 1.15 MP for older models and ≤2,576 px / 4,784 visual tokens for Opus 4.7+; OpenAI original detail
  up to a cap).
- F22. A `computer-operator` agent definition: a vision model, only the computer tools plus `read`, and a prompt on
  verify-after-act. Coordinators delegate desktop work to it, so screenshots stay out of the coordinator's context.
- F23. Jev (via `classify`) answers the risk gate (F12) and, in a later phase, closed-candidate next-element
  choices.

## Non-functional requirements

- N1. **Latency:** Driver round-trip for an AX action ≤300 ms (p50) on the host, and an observe with a window
  screenshot ≤600 ms. The model call dominates; everything else stays out of the way.
- N2. **Tokens:** median ≤3k input tokens added per step (tree plus at most one image). Retained screenshots are
  capped (default: the last 3 images per conversation), pruned in batches so the prompt cache prefix stays stable
  (memory `anthropic-cache-checkpoints`).
- N3. **Stability:** Driver crashes, hangs or a broken MCP pipe restart the client once and fail the call with a
  clear error. They never take the Ultimate host down. A hung call times out (default 30 s per action, 120 s per
  batch).
- N4. **Isolation:** no Driver process exists until the first call. Nothing is installed by the extension.
  Sandboxes have their own lifecycle and disk budget, and creation stops while free disk is below 20 GB.
- N5. **Privacy:** screenshots are kept in the conversation's storage (like browser screenshots), not in `/tmp`.
  The audit log holds no content.
- N6. **Upgrade safety:** the Driver version is pinned. A mismatch is a setup card, not a crash.
- N7. **Testability:** the core path is tested with a fake MCP Driver (no desktop, no real waits). Live checks are
  manual and bounded.

## Success metrics

Measured on a fixed suite of 10 host tasks (Calculator 6×7 = 42, save a TextEdit note, read a System Settings
value, rename a file in a scratch Finder folder, fill a local web form in Safari, export a Preview PDF, and four
more like them), run once per model with the user's OK:

| Metric                                                                         | Target                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------- |
| Task success (independent oracle, not the model's claim)                       | ≥80% with Claude Opus 5.x, ≥70% with GPT-6.x |
| Consequential actions executed without consent                                 | 0                                            |
| Focus or pointer steals in background mode, on apps the Driver ledger supports | 0                                            |
| Silent repeats after a forced restart mid-batch                                | 0                                            |
| Stop latency (button to Driver idle)                                           | ≤1 s                                         |
| Median added tokens per step                                                   | ≤3k                                          |
| Median steps per task                                                          | ≤12                                          |
