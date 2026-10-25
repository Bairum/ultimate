Advisor is an optional second-model review of agent conversations: quiet by default, with role-specific rubrics, read-only checkout tools, durable advice and daily spending limits. The extension loads by default but does no reviewing until a role is explicitly enabled. There is no fallback to the agent's model.

## Configure

Put `advisor` in `~/.ultimate/settings.json` or a trusted project's `.ultimate/settings.json`:

```json
{
  "advisor": {
    "model": "openai/gpt-4.1:off",
    "dayUsd": 5,
    "advisors": {
      "verification": { "maxToolCalls": 6, "maxNotes": 3 }
    },
    "roles": {
      "coordinator": { "enabled": true },
      "ultimate": { "enabled": true }
    }
  }
}
```

Use a model available in your configured providers; the model above is an example, not an automatic selection. Settings merge built-in defaults, user, then trusted project, field by field (including each role and each named advisor). An invalid layer is ignored with a notice. Untrusted project settings and rubrics are ignored even when project settings would be empty.

### Every field

- `model`: `provider/id[:thinking]`; unset means skip (`no model`). Thinking: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- `dayUsd`: global daily USD budget, default 5, nonnegative.
- `advisors`: named roster. Each name is 1–40 lowercase letters, digits or hyphens. Each entry accepts `model` (overrides global), `rubric` (filename without `.md`, defaults to advisor name), `maxToolCalls` (1–20, default 6), `maxNotes` (1–10, default 3 non-blockers; blockers are exempt).
- `roles`: profiles keyed by the definition name, or `ultimate` for standing @ultimate. Unknown roles, roots, side chats and unlabelled conversations are never reviewed.
- Profile `enabled`: default false for every role.
- `advisors`: ordered advisor names.
- `at`: any of `answer`, `rounds`, `signals`, `idle`.
- `every`: rounds between periodic reviews, integer ≥1, default 5.
- `gate`: `none` or `jev`; rounds/signals/idle require Jev probability ≥0.5 when gated. Missing classifier skips (`gate unavailable`). Answers are not gated.
- `delivery`: `note` (default: passive user-model context) or `card` (display only, no model context).
- `continueOn`: `nit`, `concern`, `blocker` (default), or `never`. A held final answer may continue once per run.
- `steerOn`: the same thresholds, default `never`, for mid-run advice.
- `quietMs`: nonnegative milliseconds after a user/parent/@ultimate steer, message or passive note arrives during the current run; intervention becomes a passive note for this period. The initial brief does not count. Default 600000.
- `idleMs`: nonnegative idle duration, default 1800000. Scanned every five minutes; one review per last activity, never waking a conversation.
- Profile `dayUsd`: optional nonnegative role-specific daily USD limit, in addition to the global limit.

Enabled-role defaults:

| Role                                | Advisors              | Review points           | Special defaults                                      |
| ----------------------------------- | --------------------- | ----------------------- | ----------------------------------------------------- |
| ultimate                            | promises              | answer, idle            | Never holds, continues or steers                      |
| coordinator                         | process, verification | answer, rounds, signals | Jev gate, every 5                                     |
| worker, designer                    | scope, verification   | answer                  |                                                       |
| scout, reviewer, dream-pass, lander | verification          | answer                  |                                                       |
| watcher                             | process               | signals                 |                                                       |
| computer-operator                   | monitor               | answer                  | Card only by default; monitoring, never safety advice |

## Rubrics and output

Rubrics resolve from this extension's `rubrics/`, then `~/.ultimate/advisors/`, then trusted `<project>/.ultimate/advisors/`. Files are `<name>.md`, at most 20 KB. Built-ins cover verification, scope, process, promises and computer monitoring. Silence is preferred; evidence must cite transcript entries or file lines actually read. Advice is deduplicated against this conversation's last 24 hours, with higher severity still eligible.

The model returns JSON notes (`severity`, `note` ≤500 characters, `evidence` nonempty ≤300). Only @ultimate can update the promise/question ledger (`add`, `resolve`). @ultimate receives passive model notes only when an unanswered question or overdue promise is open; everything else is a card. The user can resolve/dismiss notes or give thumbs feedback.

Deterministic signals name repeated identical tool calls, three consecutive tool errors, force-push/hard-reset/destructive deletion commands, writes outside the checkout, completion claims immediately after a failed check, and runs over 40 tool rounds. Cleanup targets confined to descendants of `/tmp`, `$TMPDIR` or the OS temp directory are excluded; mixed, non-temp or uncertain targets still signal. Signals request a review, not a safety decision.

## Safety and cost

Reviews receive a bounded request, the latest 25 clipped tool calls/results, latest agent text, checkout AGENTS.md (8 KB), and @ultimate's ledger, not the whole agent context. Requests including review-tool exchanges are capped at about 24k estimated tokens (96k characters). Transcript and file contents are untrusted data, never instructions. Read and grep resolve real paths beneath the conversation's checkout, reject symlink escapes and secret-like names, and refuse private `.ultimate/` paths except advisors, extensions and settings.json. Tool output is capped at 8 KB and grep at 50 matches. Tools are read-only; advice is guidance to weigh, not orders to obey. It never replaces the main agent's permission gates.

Non-ultimate final-answer reviews hold the yield for at most a 90-second model-call deadline, failing open. Other reviews use durable background tasks with memoized model steps and tool results so restart replay does not repeat completed calls. Delivery uses a persisted outbox and stable request ids. Provider errors never fail the agent's run. Pause gates apply to model calls.

Spend comes from each response's `usage.cost.total`, attributed to the reviewed conversation and UTC day/role. Limits are checked before each review: an in-flight review can cross a budget, concurrent reviews can overlap, and missing provider cost estimates cannot be corrected here. Jev gating is separate classifier usage, not a priced chat response. Keep budgets small initially; each configured advisor is a separate review with potentially several model/tool turns. State retains 500 notes, dropping oldest resolved/dismissed notes first.

## Actions and documents

`config` reads effective settings, layers, trust, rubrics and validation problems. User-only/host `setConfig {scope, config}` replaces a layer's advisor key (`null` removes it); `setRubric {scope, name, text}` writes/deletes a rubric (`text: null` deletes). Project writes require trust. User-only `feedback {note, feedback?, status?}` sets thumbs (`up`, `down`, or null) and/or status (`open`, `resolved`, `dismissed`).

`advisor.state` is on the root conversation, `advisor.ledger` on @ultimate, and private `advisor.runs` stores scheduling/latches/outbox. Every review and skip emits `advisor.reviewed`; delivered entries use `advisor.note`.
