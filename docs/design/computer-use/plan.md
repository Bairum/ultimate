# Computer use: phased plan and decisions

Sizes: **S** ≤ 1 day of agent work and ≤400 lines; **M** 1–3 days and 400–1,500 lines; **L** more.
Every phase lands on its own and is reviewed. UI phases go through preview rounds (`ui-preview-round`).

## Decided (2026-10-25)

1a host desktop with per-app consent · 2a Cua Driver pinned (0.37.0, installed) · 4a three curated tools (Jev goal
mode lives inside `computer_act`) · **5b Jev-first for routine steps, frontier model as planner and fallback** · 6a
per-app consent granted only by the user · 7a @ultimate may grant within a hands-off goal's scope · 8a official MCP
SDK · 9a spike done ([spike.md](spike.md)). Question 3 is answered in [cua-agent-loop.md](cua-agent-loop.md):
recommendation 3a below.

## Phases

| Phase                             | Size                       | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Needs from the user                                               |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **0. Spike**                      | S                          | **Done.** The Driver works in the background on this Mac. Latency, the display-awake behaviour, held keys, stop semantics and intervention detection are all in [spike.md](spike.md).                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                 |
| **1. Host core, explicit mode**   | M (≈1.0k lines plus tests) | `extensions/computer-use/`: `driver.ts` (MCP stdio, version pin, restart-once, idle `cua-driver stop` after 5 min), `computer_observe`, `computer_act {actions}` dispatched one step at a time with the journal, `expect` and a post-act observation, `computer_apps`; per-app consent as a user-only action; the deny list and consequential rules; the two-level Stop; act and observe cards and the status line; image caps per model; the `computer-operator` agent. Fake-Driver tests for the core path.                                                            | Preview approval of the cards.                                    |
| **2. Jev goal mode**              | M (≈600 lines plus tests)  | `jev.ts`: the candidate builder (role classes, ≤24, stable IDs, risky labels excluded), one `classify.ask` per step (`next`/`done`/`risk`), the decision rules and thresholds as settings, per-step verification, `done_when` through `verify_state`, escalation with reason codes, journalled decisions; the goal-mode card (Jev steps with their probabilities, escalations highlighted); the planner prompt for when to use it. Tests: fake Driver plus a fake classify, covering act, escalate on low confidence, escalate on no effect, and the verified-done path. | TypeSafe tokens (small).                                          |
| **3. Panel and hygiene**          | S–M                        | The Computer panel (setup and TCC state, live screenshot, consents with revoke, the per-app "no Jev" switch, tokens and Jev share); screenshot retention with batch pruning; `type_secret`; consent requests mirrored to @ultimate; per-task budget (steps, minutes, $) and lenient argument normalisation (both ported from cua-agent).                                                                                                                                                                                                                                 | Preview approval.                                                 |
| **4. Eval and calibration**       | M                          | The 10-task host suite with external oracles. Arms: explicit-only vs Jev-first, on Claude Opus 5.x, one run each, serial (≈20 runs, ≈1–1.5 h of the desktop, ≈1–2M frontier tokens plus TypeSafe calls). Threshold tuning from journalled decisions, and an opt-in trajectory export.                                                                                                                                                                                                                                                                                    | Approval of the run budget (memory `benchmarks-must-be-bounded`). |
| **5. Remote and sandbox targets** | M                          | `remote:<name>` over SSH/Tailscale; `sandbox:<name>` through the `cua` CLI on Docker (Linux gVisor container), created only on a user action, deleted on conclude, with a disk check.                                                                                                                                                                                                                                                                                                                                                                                    | OK to install the `cua` CLI and pull the Linux image (a few GB).  |
| **6. Later, each a separate go**  | M–L                        | The native Anthropic `computer_toolset_20260801` adapter once `pi-ai` supports client toolsets (upstream); a listen-only user-intervention detector (needs Input Monitoring); `parse_visual_regions` via user-installed `cua-perception` (AGPL) for canvas apps; a macOS VM via Lume when disk allows; CUA-S1 (local, cua's own System-1 model) as an offline alternative to Jev.                                                                                                                                                                                        | —                                                                 |

Phases 1–2 make the Jev-first feature usable and safe on this Mac. Phase 4 proves it with numbers.

## Remaining decisions

1. **cua's Python agent (question 3):** (a) skip the side-by-side, and port its budget manager, trajectory export
   and argument normalisation (cua itself deprecated the package); (b) run the bounded side-by-side anyway
   (≈1–1.5 h of the desktop, ≈$20–50, plus a Python venv).
2. **Stop, second level:** (a) a second Stop, or a step overrunning by 1 s, runs `cua-driver stop`, which kills every
   Driver session on this Mac; (b) never hard-kill: wait for the step in flight to finish.
3. **Display sleep:** (a) stop the Driver daemon after 5 idle minutes, so the Mac can sleep (≈80 ms restart cost);
   (b) leave it running: the display then never sleeps while it is up.
4. **What Jev may see:** (a) labels and non-secure values (truncated) for every consented app, plus a per-app "no
   Jev" switch; (b) labels only, never values; (c) Jev only for apps the user marks.
5. **Jev thresholds to start:** (a) conservative: act at p ≥ 0.80 with a 0.25 margin, done at ≥ 0.85, risk
   escalates at ≥ 0.30, tuned in phase 4; (b) aggressive (p ≥ 0.65) for more Jev share and more escalations caught by
   verification.
6. **Phase order:** (a) explicit mode first (phase 1), then Jev goal mode (phase 2), so goal mode builds on a tested
   executor and cards; (b) build both together in one phase.
7. **User-intervention test:** (a) skip for now: the design does not depend on it; (b) 2 minutes of the user typing
   in TextEdit while the agent edits it, to see how the Driver behaves.

My picks: 1a 2a 3a 4a 5a 6a 7a.
