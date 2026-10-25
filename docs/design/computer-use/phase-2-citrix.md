# Computer use phase 2: pixel surfaces, with Citrix as the driving case

The driving use case is real testing of the USG project's OpsMate AI platform through Citrix (the browser client or the
Workspace app): uploading and installing skills, driving the platform's agents, and running test, validation and
evaluation scenarios. Inside Citrix there is no accessibility tree, only pixels. The same holds for canvases, remote
desktops and games.

Sources: trycua/cua at `3cc240d` (2026-10-25): the `cua-driver` 0.38.0 changelog; the guides `vms-and-remote`,
`MACOS.md`, `VISUAL.md`, `WORKFLOW.md`; `perception-extension.md`; the `cua-perception-v0.2.1` release assets; and the
phase 1 live check ([spike.md](spike.md)).

## Decisions (2026-10-25)

1. **Pixel grounding (1a):** the frontier model reads the screenshot and gives coordinates. Every pixel click carries an
   **expected label**, and OCR checks that label at the click point before dispatch (`label_mismatch` otherwise). The
   native Anthropic toolset can come later, once Pi supports client toolsets.
2. **OCR (2b): cua's PP-OCR, not macOS Vision.** It may be used only without the AGPL OmniParser detector (see "OCR
   engine" below: the cua bundle cannot do that). Installing needs the user's OK.
3. **Pre-approval (3a):** the user approves a scope once per task (app and window, pixel actions, allowed kinds, a step
   and time budget, and a foreground takeover for the run). Label-checked pixel steps inside that scope need no card.
   Consequential steps still need one, unless their label is listed verbatim in `scope.consequential`.
4. **Where runs happen (4a):** this Mac, in a foreground "operator mode" with the Citrix window visible. The user
   steps away, and Stop stays on the status line. In parallel, USG IT is asked about running the Driver inside the
   Citrix session.
5. **Results (5b): free-form prompts, no scenario-file runner.** Each task keeps a results and evidence summary
   through `computer_task` (criteria, sub-goals, evidence screenshots and OCR excerpts) and the report card.
6. **Order (6a):** the 2.0 probe with the user comes first.

## What cua offers, and our gaps

| Limit                 | cua today                                                                                                                                                                                     | Plan                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No accessibility tree | `get_window_state` returns `degraded: true` with an empty tree and a screenshot. `click {x, y, capture_id}` is consumed once and refuses stale frames. `zoom` returns a full-resolution crop. | Pixel steps with an expected label checked by OCR. Re-screenshot after each step; the step is verified when the screen settles and the OCR shows the expected change. Evidence is captured by the extension. |
| OCR                   | Only the `cua-perception` extension, whose `parse_visual_regions` returns text and icon regions.                                                                                              | See "OCR engine".                                                                                                                                                                                            |
| `wait`                | No wait tool. `run_steps` steps take `wait_for`/`expect` checks: tree text including static text, `gone`, at most 10 s, a batch at most 60 s, and not cancellable.                            | Our own cancellable `wait {until: text \| gone \| stable, timeout}`, built on screenshots, OCR and frame stability.                                                                                          |
| Focus                 | Background delivery covers native apps. Screen Sharing forwards physical keycodes, so it needs `delivery_mode: "foreground"` with a `window_id`.                                              | Citrix Viewer probably behaves the same (the probe confirms this). The run takes a foreground takeover, approved with the scope.                                                                             |
| Stage Manager         | Not addressed. Background windows report thumbnail bounds and thumbnail screenshots (phase 1 live check).                                                                                     | Detect it (window bounds don't match the AX frame, or the window is off-screen) and refuse with `window_not_visible` and guidance: show the window, or turn Stage Manager off for the run.                   |
| Remote session        | The Driver runs on the machine it drives. For a remote machine, MCP goes over SSH. On Windows the daemon must run in the interactive session.                                                 | If USG IT allows it, the Driver inside the Citrix Windows session would give a full UIA tree, and Jev works natively there.                                                                                  |
| Display sleep         | The Driver keeps the display awake for 10 minutes after each call.                                                                                                                            | `caffeinate -d -w <pid>` while a long wait runs.                                                                                                                                                             |
| Credentials           | None.                                                                                                                                                                                         | `type_secret {name}` from Secrets, never shown to the model. Screenshots taken after secret entry are not kept.                                                                                              |

## OCR engine

`cua-perception` 0.2.1 (aarch64-apple-darwin) is **one signed archive of 426 MB** (`.tar.gz`, `LicenseRef-Mixed`,
SBOM `AGPL-3.0-only AND Apache-2.0 AND BSD-3-Clause AND MIT`). Its runtime contract lists three models with
`rejectMismatch: true`:

- `omniparser-icon-detect-1280-opset17.onnx` (AGPL-3.0-only)
- `ppocrv5-mobile-det.onnx` (Apache-2.0)
- `ppocrv5-mobile-rec-en.onnx` (Apache-2.0)

The archive also carries ONNX Runtime and the worker. It installs into the Driver's own extension store
(`cua-driver extension install`, under `~/.cua-driver`), needs **no Python**, and runs locally without network access.
Its install-check parse took about 4 s.

The verified bundle cannot be installed without the AGPL detector. Removing that model breaks hash verification, and
the parse option `kinds` only limits what is returned. **Per the user's condition, nothing is installed.** Options:

- **(a)** Install cua-perception as is: 426 MB, no Python, AGPL detector present. Private local use triggers no AGPL
  source obligation, but the user asked to avoid it.
- **(b)** Run the same PP-OCR v5 mobile models (Apache-2.0; PaddleOCR is Apache-2.0) ourselves with `onnxruntime-node`
  (MIT; about 300 MB unpacked on npm for all platforms). This needs about 300 lines of pre/post-processing (DB text
  detection, CTC decoding). No Python, no AGPL. The models are a few MB each and would be downloaded at setup, with
  the user's OK.
- **(c)** macOS Vision (`VNRecognizeTextRequest`) through a small Swift helper: nothing to install, macOS only.

## Design

1. **Screenshot-grounded steps.** On a degraded window, a `computer_act` pixel step is
   `{kind, x, y, capture, expect_label}`. Before dispatch, the extension OCRs a crop around the point. The step goes
   ahead only if `expect_label` matches a text box under the point (normalised, unique). Otherwise it is refused with
   `label_mismatch` and the boxes found. Zoom crops serve small text. Coordinates stay bound to the capture.
2. **Jev over OCR boxes** (goal mode on pixel surfaces). Candidates are OCR boxes with confidence ≥ 0.8 and unique
   text, at most 24. Jev uses the same thresholds, risk question, verification and escalation as phase 1. A click goes
   to the box centre, bound to its capture. Icon-only controls escalate to the planner.
3. **Scoped pre-approval** in the task spec: `approval {app, window, pixel: true, actions, steps, minutes, foreground}`,
   confirmed once on the task card through user-only and host-only actions (it joins #34448's `hostActions`). Inside
   the scope, label-checked steps run without cards. Consequential labels (send, delete, pay, install, upload,
   publish), found by OCR at the click point and by the risk check, still need a card unless listed verbatim in
   `scope.consequential`.
4. **Results and evidence.** There is no runner (5b). A free-form prompt becomes a `computer_task` with criteria and
   sub-goals. Evidence holds screenshots and OCR excerpts. The report card shows met, unmet and blocked items with
   evidence thumbnails and timings. Long waits on the platform's agents use `wait` (cancellable, with `caffeinate`).
5. **Other limits:**
   - stability-based settling instead of fixed delays (remote latency);
   - typing only into a label-checked focused field;
   - typed text checked by OCR (never for secrets);
   - `type_secret` for the Citrix and OpsMate logins;
   - skill upload through Citrix file transfer or clipboard redirection, whichever the probe finds;
   - clipboard paste as the fallback.
6. **USG packaging (sketch; started from USG):** `usg/.ultimate/agents/usg-tester.md` (based on computer-operator),
   `usg/.ultimate/skills/citrix-opsmate/` (login flow, screens, how to install a skill and drive the platform's
   agents, evaluation rubrics), and project settings that enable computer-use for USG only.

## 2.0 probe (about 20 minutes, the user at the Citrix login)

It measures, for the Workspace app and, if available, the browser client:

1. tree content (expected to be empty or degraded);
2. window id, bounds and capture size, with and without Stage Manager;
3. screenshot latency and frame-update latency after an input;
4. whether background clicks and keys arrive, or need foreground;
5. keyboard mapping (ASCII, digits, `@`, `-`, `_`, and one accented character), read back from the screen;
6. clipboard redirection (Mac → remote paste);
7. whether the remote upload dialog shows mapped client drives;
8. whether the display stays awake;
9. zoom readability of small text.

All inputs are harmless: a click on a blank area or a navigation link the user names, and typing `probe-123` into a
field the user names, never submitted. The user types every credential.

## Phases

| Phase | Size | Scope                                                                                                                    |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 2.0   | S    | Citrix probe; question to USG IT about running the Driver in the session                                                 |
| 2.1   | M    | OCR engine (per the decision above), label-checked pixel steps, zoom, `wait`, settle and verify, Stage Manager detection |
| 2.2   | S–M  | Scoped pre-approval in the task spec, OCR-based consequential check, run-level foreground takeover                       |
| 2.3   | S–M  | Jev picking among OCR boxes                                                                                              |
| 2.4   | S–M  | Results and evidence summary in `computer_task` and the report card, long-run keep-awake                                 |
| 2.5   | S    | `type_secret`, clipboard and file-transfer helpers (after the probe)                                                     |
| 2.6   | S    | USG packaging, in the USG project                                                                                        |
