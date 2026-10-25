# Computer use: phased plan and decisions

Sizes: **S** ≤ 1 day of agent work and ≤400 lines; **M** 1–3 days and 400–1,500 lines; **L** more.
Every phase lands on its own and is reviewed. UI phases go through preview rounds (`ui-preview-round`).

| Phase                                | Size                       | Delivers                                                                                                                                                                                                                                                                                                                                                                                                         | Needs from the user                                                                                                                                              |
| ------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Spike**                         | S                          | A throwaway script (not committed) that spawns `cua-driver mcp`, lists apps, observes Calculator, computes 6×7 through AX in the background and reads back 42. It measures observe/act latency, tree and image token sizes, and checks behaviour on restart and cancel (held keys, display sleep, user typing). Findings get appended to `risks.md`.                                                             | OK to install Cua Driver (the official installer) and grant Accessibility and Screen Recording to CuaDriver.app. About 15 minutes; no VM, a few cents of tokens. |
| **1. Host MVP**                      | M (≈1.2k lines plus tests) | `extensions/computer-use/`: `driver.ts` (MCP stdio, pinned version, restart-once), `computer_observe`, `computer_act` (journal, stop at first failure, post-act observation, `expect`), `computer_apps`; per-app consent as a user-only action; the deny list; Stop (card, status line, ⌘K); act and observe cards; image scaling per model; the `computer-operator` agent; fake-Driver tests for the core path. | Preview approval of the cards.                                                                                                                                   |
| **2. Panel and hygiene**             | S–M                        | The Computer panel (setup and TCC state, live screenshot, consents with revoke, token spend); screenshot retention and batch pruning; `type_secret`; consent requests mirrored into @ultimate's conversation.                                                                                                                                                                                                    | Preview approval.                                                                                                                                                |
| **3. Jev risk gate**                 | S                          | Consequential rules plus a Jev yes/no through `classify` (`want`), with a "goal reached?" yes/no as an extra verify signal. A small bounded eval of the gate on recorded step descriptions (no desktop).                                                                                                                                                                                                         | TypeSafe tokens (small).                                                                                                                                         |
| **4. Remote and sandbox targets**    | M                          | `remote:<name>` over SSH/Tailscale; `sandbox:<name>` through the `cua` CLI on Docker (Linux gVisor container), created only on a user action, deleted on conclude, with a disk check.                                                                                                                                                                                                                            | OK to install the `cua` CLI and pull the Linux image (a few GB). A remote Mac with the Driver, if wanted.                                                        |
| **5. Eval suite and native adapter** | M (+ upstream)             | The 10-task host suite with external oracles (bounded: one run per model, at most 2 concurrent). An optional adapter for Anthropic's `computer_toolset_20260801` once `pi-ai` supports client toolsets (upstream PR), compared on the suite.                                                                                                                                                                     | Approval of the run budget per memory `benchmarks-must-be-bounded`.                                                                                              |
| **6. Experiments**                   | M–L                        | The Jev System-1 picker for routine sub-goals (the cua `jev-use` recipe); optional `parse_visual_regions` through user-installed `cua-perception` (AGPL); a macOS VM target via Lume when disk allows.                                                                                                                                                                                                           | Separate go for each.                                                                                                                                            |

Phases 0–2 make a usable, safe host feature. Phases 3–4 add what makes it distinctive (Jev, targets). Phases 5–6
are optional.

## Decisions

1. **Default target:** (a) the host desktop with background delivery and per-app consent, sandboxes opt-in;
   (b) a Linux container sandbox by default, host opt-in (safer, but it cannot automate your Mac apps, which is use case 1);
   (c) a macOS VM by default (≈50 GB; this Mac has 65 GB free against a 20 GB floor).
2. **Backend:** (a) Cua Driver through `cua-driver mcp`, pinned (MIT; CuaDriver.app holds the TCC grants);
   (b) port omp's Rust `pi-natives` desktop module (MIT, 53k lines, TCC grants land on Ultimate's launcher);
   (c) adopt `@amaster.ai/pi-computer-use` as is (a Pi extension: no replay semantics, 62 tools, no Ultimate UI).
3. **Agent loop:** (a) Ultimate's own loop, plus a `computer-operator` subagent definition for delegated desktop
   work; (b) delegate to cua's Python agent loops (composed grounding, UI-TARS) in a sidecar.
4. **Tool surface:** (a) 3 curated, AX-first function tools that work on every model; (b) mimic Anthropic's
   native 17-member toolset as function tools; (c) expose all Driver tools.
5. **Jev's role:** (a) the risk gate and "done?" check through `classify` in phase 3, and the System-1 picker as a
   phase 6 experiment; (b) the picker early, as the main loop for routine steps; (c) no Jev.
6. **Consent scope:** (a) per app, granted only by the user (once / conversation / project), forks inherit
   conversation grants, consequential steps always confirmed; (b) the same, but forks start without grants;
   (c) a single "allow computer use in this project" switch.
7. **Hands-off goals:** (a) @ultimate may grant app consent within the goal's scope, never for deny-listed apps or
   money; (b) computer use is refused while hands-off.
8. **MCP client:** (a) add `@modelcontextprotocol/sdk` (the Driver examples and both Pi packages use it);
   (b) hand-write about 150 lines of JSON-RPC over stdio.
9. **Spike now:** (a) yes: install Cua Driver and grant permissions for phase 0 on this Mac; (b) not yet, build
   phase 1 against the fake Driver first.

My picks: 1a 2a 3a 4a 5a 6a 7a 8a 9a.
