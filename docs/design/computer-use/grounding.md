# Computer use: staying anchored to the user's intent

The user asked how a computer-use run stays on the original task across many steps: intent capture, tracking,
grounding mechanics, completion, interruptions, and prior art. This document proposes the mechanism. Goal mode does
not land without it (plan.md, phase 1).

## The problem

A desktop run is long (tens of steps), noisy (each observation is hundreds of tokens of UI), and adversarial (screens
contain text that is not the user's). These failure modes show up in every computer-use system below:

1. **Premature victory:** declaring done because the last action "went through".
2. **Drift:** wandering into apps, windows or data the task never needed, sometimes because a screen told it to.
3. **Loops:** repeating an action that has no effect, or oscillating between two states.
4. **Goal erosion:** after compaction, a crash or a long run, the original words are gone. The agent then works from
   its own paraphrase, which drifts.
5. **Silent replanning:** quietly redefining what "done" means when the original criteria get hard.

The mechanism answers each with **durable state plus code-enforced gates**, not just prompting: the prompt guides,
and the tools refuse.

## Prior art

| Source                                                                   | What it does for grounding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | What we take                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cua `jev-use` task spec** (read in `libs/cua-driver/examples/jev-use`) | Each task is a typed spec: goal, parameters (secrets marked for redaction), step budget, **allowed action kinds**, a form-state summary, the candidate rules and **a success oracle independent of the model**. `progress` counts each declared step from the runner's **own successful actions, never read from the app**.                                                                                                                                                                                                                                                                                                            | The spec shape, allowed actions as scope, an independent oracle for done, and progress taken from our own verified actions.                                                                              |
| **Anthropic, "Effective harnesses for long-running agents"** (fetched)   | An initializer writes a **JSON feature list**, all `passes: false`. Later sessions read it first, work **one feature at a time** and may change **only the `passes` field**: "It is unacceptable to remove or edit tests". There is a progress file and git history. JSON was chosen because "the model is less likely to inappropriately change or overwrite JSON files".                                                                                                                                                                                                                                                             | An immutable intent and criteria, status-only edits, one active sub-goal, and re-reading the durable state at every session start.                                                                       |
| **Anthropic computer use docs**                                          | Verify after actions; prune screenshots in batches; screen content can inject; human oversight for consequential actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Already in the design.                                                                                                                                                                                   |
| **OpenAI computer use**                                                  | "Check the screen after a short group of actions". `pending_safety_checks` include **`irrelevant_domain`**, a built-in drift guard that needs human acknowledgement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A scope check per action, with out-of-scope needing the user.                                                                                                                                            |
| **browser-use** (`browser_use/agent`, read at `3df5806`)                 | Every step outputs `evaluation_previous_goal`, `memory` and `next_goal`. There is a `todo.md` checklist plus a `plan` with `[x]/[>]/[ ]/[-]` markers and `current_plan_item`. The prompt says _"Completing all plan items does NOT mean the task is done. Always verify against the original <user_request>"_. `ActionLoopDetector` hashes actions in a window of 20 and fingerprints page stagnation; it adds **soft** nudges at 5/8/12 repeats and 5 stagnant pages. `planning_replan_on_stall=3` adds a replan nudge after 3 failures; `max_failures=5` ends the run. A separate **judge** model grades the trace against the task. | A checklist with one current item, loop and stagnation detection (made **hard** for repeats with no effect), replan-on-stall, verification against the original request, and an independent judge (Jev). |
| **Agent-E** (Emergence, 2024; from prior knowledge, not re-read)         | Hierarchical planner and navigator. **Change observation:** after each action the navigator reports what changed in the DOM, so the planner learns whether the action worked.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Per-step effect verification (already in goal mode) and step results phrased as observed changes.                                                                                                        |
| **Agent S / S2, UFO, Reflexion** (from prior knowledge)                  | A manager/worker split with subtask lists (Agent S), host and app agents with per-app scope (UFO), verbal self-reflection after failure stored for the next attempt (Reflexion).                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The planner/worker split we already have (operator plus Jev), per-app scope, and a recorded reason on each replan.                                                                                       |
| **omp**                                                                  | Its computer docs define safety (untrusted screen text, confirming consequential actions, `control.acquire` with a reason) but no task anchoring specific to computer use.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Nothing new.                                                                                                                                                                                             |
| **Ultimate's own `goal` extension**                                      | Criteria with `met`/`failed`, blocked after 3 failed tries, a `goal.note` re-injected **per input, never in the system prompt, so the prompt cache holds**, and a report card at the end.                                                                                                                                                                                                                                                                                                                                                                                                                                              | The same pattern: per-input note, criteria lifecycle, report card.                                                                                                                                       |

The common thread: **write the intent down once in a form the agent cannot casually rewrite, check progress against
it with something other than the acting model's own judgement, and refuse to continue when the run stops serving it.**

## Proposal

### 1. Intent capture: the task spec

A run starts with `computer_task {action: 'start', spec}`. **`computer_act` refuses without an active task**, so no
step happens unanchored. The spec is stored in a durable `computer.task` document on the operator's conversation:

```ts
type TaskSpec = {
  id: string // T1, T2 … per conversation
  intent: string // the user's words, verbatim, from the brief; immutable
  goal: string // the planner's restatement in one sentence
  criteria: { id: string; text: string; check: Predicate[] | 'evidence' }[] // what done means; each checkable
  scope: {
    apps: string[] // apps the task may touch; each still needs consent
    params: Record<string, string> // the data it may enter, by name (values never go to Jev)
    actions: Step['kind'][] // allowed step kinds, e.g. no 'key' chords
    consequential: string[] // consequential steps the user pre-authorized, verbatim ("Save the document")
  }
  stop: { steps: number; minutes: number; escalations: number } // defaults 60 / 15 / 6
  link?: { conversation: number; task?: string } // the coordinator and its plan task (E1.3), for the report
}
```

- **Verbatim intent.** The coordinator passes the user's words in the operator brief, and the spec stores them
  unchanged. The anchor (§3) always shows them, so the run never works only from a paraphrase.
- **Confirmation when ambiguous.** The spec goes to the user as a confirm card (a user-only `confirmTask` action,
  relayed through @ultimate like consent) when any of these hold:
  - a criterion has no check (only `evidence`);
  - scope has more than 3 apps;
  - `consequential` is non-empty;
  - the intent and the goal share no content words (a cheap heuristic for "the planner reinterpreted it").

  Otherwise the task starts at once. The card shows the intent, the goal, the criteria and the scope, side by side.

- **Scope is enforced in code.** An act on an app outside `scope.apps` or with a kind outside `scope.actions` is
  refused with `out_of_scope` before consent is even checked. A consequential step not listed in
  `scope.consequential` still needs its confirm card, as before.

### 2. Tracking: checklist, evidence and ledger

In the same document:

- **Sub-goals:** `[{id, text, status: 'pending'|'active'|'done'|'blocked'|'skipped', attempts, evidence: Evidence[]}]`.
  The planner sets them with the spec or on the first replan. **One is active at a time** (Anthropic's "one feature
  at a time"; browser-use's `[>]`). Each `computer_act` names the sub-goal it serves (`subgoal: 'S2'`), and goal
  mode is one sub-goal by construction.
- **Evidence is extension-written, never model-written.** It is a verified `verify_state` result (predicate plus
  verdict), an AX excerpt with its snapshot id, or a capture id with its stored PNG path, each with the journal entry
  that produced it. A sub-goal becomes `done` only with at least one evidence item from a step that served it.
- **Progress comes from our own actions** (cua's rule): progress counts are derived from journalled, verified steps,
  never from what the screen claims.
- **Ledger:** every transition (sub-goal or task status, replan, drift event, checkpoint) is appended with time, the
  reason and the journal reference. The step journal and the Jev decisions (already designed) are the fine-grained
  log beneath it.
- **Reuse where it fits.** `plan` stays the coordinator's ledger; the spec links to the plan task, and the operator's
  final report is what the coordinator records there. The `todos` (@ultimate-only, project-level) and `goal`
  (hands-off, @ultimate-only) extensions do not fit a per-operator checklist. We reuse their _patterns_: the goal
  extension's criteria lifecycle and per-input note, and the plan pill's progress display.

### 3. Grounding mechanics

1. **The anchor footer on every computer tool result.** About 60–120 tokens, appended at the end of the result (new
   content only, so the cached prefix is untouched):
   `Task T2 · intent: "Export the Q3 sheet as PDF to Desktop" · S2/4 active: "Choose PDF in Export" · criteria 1/2 met · steps 14/60 · scope: Numbers · last check: on task (step 10)`.
   The model sees the intent and its position after every action without a system-prompt change.
2. **A per-input note** (like `goal.note`): at the start of each run of the operator, while a task is active, the
   full spec, the checklist with statuses and the last 5 ledger lines. Never in the system prompt.
3. **On-task checkpoints, enforced.** Every 10 act steps, and immediately after any drift signal, `computer_act`
   refuses with `checkpoint_due` until the planner calls `computer_task {action: 'checkpoint', assessment}`. That
   call runs one Jev check (text only, ≈115 ms) over `{intent, goal, active sub-goal, last 10 step summaries, current
   app and window}`:
   - `on_task` (yes/no): "Is the recent activity serving the intent?"
   - `progressing` (yes/no): "Did the last steps move the active sub-goal forward?"

   With Jev on task and progressing, the run continues. Otherwise the checkpoint answer is `replan_required` with
   Jev's numbers, and the planner must replan (4) before acting again. Without a TypeSafe key the checkpoint still
   happens: the planner's written assessment is recorded and the code detectors below still apply.

4. **Drift detectors in code:**

   | Signal                | Rule                                                                           | Response                                                                        |
   | --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
   | Out of scope          | App, window owner or action kind not in the spec                               | **refuse** `out_of_scope` (the user can widen the scope through a confirm card) |
   | Repeat without effect | The same action hash 3 times in a window of 20 with no verified effect between | **refuse** `loop` until replan                                                  |
   | Oscillation           | The window outline fingerprint returns to the same 2 states 3 times            | refuse `loop`                                                                   |
   | No progress           | 15 act steps with no sub-goal reaching `done`                                  | `checkpoint_due` (Jev decides)                                                  |
   | Escalations           | `stop.escalations` goal-mode escalations                                       | stop the task as `blocked` and report                                           |
   | Unknown outcomes      | Any `unknown` step                                                             | act refused until a fresh observe (already designed)                            |
   | Budget                | `stop.steps` or `stop.minutes`                                                 | stop as `partial`, with a report                                                |

5. **Explicit replanning.** `computer_task {action: 'replan', reason, subgoals?, criteria?, scope?}`. The reason is
   required and goes to the ledger, and the old plan is kept. Sub-goals can change freely. Criteria may be **added**
   freely. **Weakening or removing a criterion, or widening scope, needs the user's confirmation** (the same confirm
   card), the computer-use form of "it is unacceptable to remove or edit tests". The intent never changes; a new
   intent is a new task.

### 4. Completion

`computer_task {action: 'finish', outcome: 'done' | 'partial' | 'blocked', summary}`:

- `done` is **refused** unless every criterion is met. A criterion with predicates is met only when the extension runs
  them through `verify_state` at finish time and gets `satisfied`. An `evidence` criterion needs at least one
  extension-recorded evidence item, and its last capture goes into the report for the planner (and then the user)
  to judge. browser-use's rule holds: finished sub-goals do not imply done; only criteria do.
- An optional **independent judge:** Jev answers "is the intent achieved?" over the final AX state of the scoped
  apps. Disagreement with the planner is written into the report, not decided silently.
- `partial` and `blocked` list each criterion as met (with evidence), unmet or unknown, plus what was tried and the
  reason it stopped. The **report card** renders that table, so the user sees an honest partial result instead of
  prose.

### 5. Interruptions: re-ground from durable state, not memory

| Event                         | Task state                                                    | On resume                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stop** (user)               | `stopped`; act refused                                        | Only the user's next message resumes it. The note and anchor re-inject the spec, and the first act needs a fresh observe of every scoped app.    |
| **User takeover**             | `paused_by_user`                                              | Re-observe. Sub-goals whose evidence came from apps the user touched become `needs_reverify`, and their predicates rerun before they count.      |
| **Crash or restart**          | Unchanged; the interrupted act shows `unknown` in the journal | The note and anchor come from the document. Act is refused until a fresh observe; the unknown step is reconciled by observation, never replayed. |
| **Compaction**                | Unchanged                                                     | Nothing is lost: spec, checklist and ledger live in the document, not in the transcript, and the next note re-injects them.                      |
| **Budget or escalation stop** | `partial`/`blocked`                                           | A new task (with a new verbatim intent from the user) is needed to continue.                                                                     |

## Cost

- The anchor is ≈100 tokens per computer tool result. Over a 60-step task that is ≈6k tokens, about four
  screenshots' worth.
- The note is ≈400–800 tokens per run start.
- A checkpoint is one Jev call (≈115 ms, a few hundred input tokens) every 10 steps.
- Code: about 400–500 lines (`task.ts`: spec, checklist, ledger, detectors, finish gate) plus tests. The new tool
  `computer_task` is a fourth tool (see decision 1 below).

## What changes elsewhere

- **architecture.md:** a fourth tool, `computer_task`; `computer_act` takes `subgoal` and refuses without an active
  task, on `out_of_scope`, `loop` or `checkpoint_due`; the anchor footer; the `computer.task` document.
- **jev.ts:** unchanged in shape. Goal mode runs one sub-goal; its decisions feed the ledger and the detectors.
- **The operator agent prompt:** start with `computer_task start` using the user's words; one sub-goal at a time;
  checkpoint when asked; replan with a reason; finish only through the gate.
- **plan.md:** phase 1 includes this; goal mode does not land without it.
