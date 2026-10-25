# Computer use for Ultimate: design

Research and design for a `computer-use` extension built on cua. Phase 0 (the spike) is done; nothing else is built.

| Document                                     | What it covers                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [capability-matrix.md](capability-matrix.md) | cua, omp, `jev-codex-cua`, `@amaster.ai/pi-computer-use`, Anthropic's and OpenAI's tools: actions, environments, models, grounding, safety, performance, licences |
| [prd.md](prd.md)                             | Users and use cases, goals and non-goals, functional and non-functional requirements, success metrics                                                             |
| [architecture.md](architecture.md)           | Extension layout, backend and loop choice, tool surface, targets, durability, consent and kill switch, secrets, tokens, UI, models, with diagrams                 |
| [risks.md](risks.md)                         | Stability, performance, accuracy, safety and macOS edge cases, with mitigations and spike items                                                                   |
| [spike.md](spike.md)                         | Phase 0 on this Mac: install, latency, display-awake, held keys, stop semantics, intervention detection                                                           |
| [cua-agent-loop.md](cua-agent-loop.md)       | cua's (deprecated) Python agent: what it does well, what we port, why no side-by-side                                                                             |
| [plan.md](plan.md)                           | Phases with sizes, decisions taken and remaining                                                                                                                  |

## Findings in brief

- **cua is now a platform, not one library.** The piece to build on is **Cua Driver** (MIT, Rust, `cua-driver mcp`
  over stdio). It drives native apps in the background on macOS, Linux and Windows without taking the user's pointer or
  focus. It offers AX element tokens, `capture_id`-bound pixels, `verify_state` and structured refusals, and it is
  proven by a per-OS action ledger. Sandboxes (`cua sb`: gVisor containers, QEMU, Lume macOS VMs, cloud) and remote
  hosts use the same Driver. Cua Spaces and cua-spacesd are FSL-1.1-MIT; `cua-perception` (OmniParser) is AGPL and
  opt-in.
- **omp** has the deepest host implementation (a Rust NAPI addon behind its Eval tool). It is too coupled to port,
  and its TCC grants would land on Ultimate's launcher. Its _policies_ carry over: frame-bound coordinates, never
  replay uncertain input, read vs exec, untrusted screen text, explicit takeover.
- **jev-codex-cua** runs on OpenAI Codex's proprietary "Sky" runtime and uses **TypeSafe Jev** as a text-only
  closed-choice decider (next element, action type, done?, risk?). **@amaster.ai/pi-computer-use** is a thin
  wrapper around Cua Driver 0.37.
- **"Jev support"** means Jev as a fast System-1 decision model over candidates built from the accessibility tree.
  cua ships this as the `jev-use` recipe (TypeSafe Jev or its own CUA-S1). Jev never sees pixels. In Ultimate it fits
  `classify` directly. By the user's decision (5b), Jev drives routine steps (goal mode) and the frontier model
  plans and takes over on escalation.
- **Anthropic's** `computer_toolset_20260801` (Claude 5.5+) and **OpenAI's** `{type:"computer"}` are pixel-only and
  need provider support that `pi-ai` lacks. Function tools over the Driver work for every model now.

## Recommendation

Build `extensions/computer-use/`. Ultimate's frontier model plans; **Jev drives routine steps** inside
`computer_act {goal}`, over AX candidates with thresholds, per-step verification and escalation; Cua Driver acts.
Three AX-first tools (`computer_observe`, `computer_act`, `computer_apps`). It defaults to the host desktop with
background delivery, per-app consent that only the user grants, a consequential-action gate, a two-level kill switch
(per-step dispatch, then `cua-driver stop`), durable step journals, live cards and a Computer panel. A
`computer-operator` subagent keeps screenshots out of coordinators. Remote Macs (SSH over Tailscale) and Linux
sandboxes come later; macOS VMs wait for disk space. See [plan.md](plan.md) for phases and decisions.
