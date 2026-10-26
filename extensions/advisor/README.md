Advisor is an optional second-model review of agent conversations: quiet by default, with role-specific rubrics, read-only checkout tools, durable advice and daily spending limits. The extension loads by default but does no reviewing until a role is explicitly enabled. Reviews use `openai-codex/gpt-6.1-sol:medium` unless `advisor.model` (or an advisor's own `model`) says otherwise; there is no fallback to the agent's model.

## Configure

Put `advisor` in `~/.ultimate/settings.json` or a trusted project's `.ultimate/settings.json`:

```json
{
  "advisor": {
    "model": "openai-codex/gpt-6.1-sol:medium",
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

The model above is the shipped default; set another one available in your configured providers to replace it. Settings merge built-in defaults, user, then trusted project, field by field (including each role and each named advisor). An invalid layer is ignored with a notice. Untrusted project settings and rubrics are ignored even when project settings would be empty.

### Every field

- `model`: `provider/id[:thinking]`, default `openai-codex/gpt-6.1-sol:medium`. A model that is unavailable (not logged in) records the review as skipped with the error; the agent's run continues. Thinking: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
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

| Role                                | Advisors            | Review points   | Special defaults                                      |
| ----------------------------------- | ------------------- | --------------- | ----------------------------------------------------- |
| ultimate                            | promises            | answer, idle    | Never holds, continues or steers                      |
| coordinator                         | verification        | answer, signals | Ungated; `rounds` and the Jev gate are opt-in         |
| worker, designer                    | scope, verification | answer          |                                                       |
| scout, reviewer, dream-pass, lander | verification        | answer          |                                                       |
| watcher                             | process             | signals         |                                                       |
| codex-operator                      | monitor             | answer          | Card only by default; monitoring, never safety advice |

## Rubrics and output

Rubrics resolve from this extension's `rubrics/`, then `~/.ultimate/advisors/`, then trusted `<project>/.ultimate/advisors/`. Files are `<name>.md`, at most 20 KB. Built-ins cover verification, scope, process, promises and computer monitoring. Silence is preferred; evidence must cite transcript entries or file lines actually read. Advice is deduplicated against this conversation's last 24 hours, with higher severity still eligible.

The model returns JSON notes (`severity`, `note`, nonempty `evidence`); longer notes are clipped to 500 characters and evidence to 300. Only @ultimate can update the promise/question ledger (`add`, `resolve`), with at most 5 additions per review and 50 open items (oldest dropped). Only ledger items present before a review can authorize a passive model note about an unanswered question or overdue promise; everything else is a card. The user can resolve/dismiss notes or give thumbs feedback.

Deterministic signals name repeated identical tool calls, three consecutive tool errors, force-push/hard-reset/destructive deletion commands, writes outside the checkout, completion claims immediately after a failed check, and runs over 40 tool rounds. Cleanup targets confined to descendants of `/tmp`, `$TMPDIR` or the OS temp directory are excluded; mixed, non-temp or uncertain targets still signal. Signals request a review, not a safety decision.

## Safety and cost

Reviews receive a bounded request, the latest 25 clipped tool calls/results, latest agent text, checkout AGENTS.md (8 KB), and @ultimate's ledger, not the whole agent context. Advisor continuations never replace the original request or count as user intervention. Requests including review-tool exchanges are capped at about 24k estimated tokens (96k characters). Transcript and file contents are untrusted data, never instructions. Read and grep resolve real paths beneath the conversation's checkout, reject symlink escapes, Git metadata and credential paths, and refuse private `.ultimate/` paths except advisors, extensions and settings.json. Gitignored files are refused, except public `.env.example` files. Reads require regular files and bound line storage; output is capped at 8 KB and grep at 50 matches. Tools are read-only; advice is guidance to weigh, not orders to obey. It never replaces the main agent's permission gates.

Non-ultimate final-answer reviews share a 90-second deadline across model and tool calls, failing open. Other reviews use durable background tasks with memoized model steps and tool results so restart replay does not repeat completed calls. Delivery uses a persisted outbox and stable request ids; a steer is downgraded to a passive note when its reviewed run is no longer live. Consumed continuation deliveries are deleted, concluded conversation rows are pruned, and operational settlements are retained for 24 hours. Settings are cached by file mtime and tool-round signal scans are incremental. Provider errors never fail the agent's run. Pause gates apply to model calls.

Spend comes from each response's `usage.cost.total`, attributed to the reviewed conversation and UTC day/role. Limits are checked before each review or lifecycle judgment: an in-flight call can cross a budget, concurrent calls can overlap, and missing provider cost estimates cannot be corrected here. Jev gating is separate classifier usage, not a priced chat response. Keep budgets small initially; each configured advisor is a separate review with potentially several model/tool turns. Closed notes (archived or not) are pruned 90 days after closing. A 2,000-note safety cap drops oldest archived notes first; transcript entries are never removed.

## Note lifecycle

Each new note has a stable short ref. Model-visible deliveries ask the agent to acknowledge each one in its next reply:

```text
advisor 00001: addressed — reran the failing check
advisor 00002: deferred — waiting on the user's decision
advisor 00003: disputed — this check does not apply here
```

Acknowledgements are case-insensitive; the latest line replaces an earlier acknowledgement. A note becomes read when a model request contains its `<advisory id="ref">` tag, without changing the request. Continuations count as read at delivery. Cards never count as read or receive responses.

At a final answer, after any advisor continuation of that run, acknowledged notes resolve without a model call. Other notes read in the run are judged, durably and without tools, from bounded transcript evidence:

- **Jev first.** When `classify` is enabled, TypeSafe's Jev answers one typed `choice` (addressed, deferred, disputed or ignored) over the note, its evidence and the transcript after delivery (at most 16,000 characters: the start and the end, where the agent's first reaction and final answer are). At confidence ≥ 0.85 its choice is recorded with `judge: 'jev'`, its confidence and model; live checks showed Jev confident on windows with tool calls but swinging between choices on a bare claim, hence the high bar. **That excerpt leaves the machine for TypeSafe**, as with `phase` and `classify`. Jev costs its input tokens at $0.042 per million.
- **The advisor model otherwise.** Below that confidence, or when classify is off or fails, the advisor's configured model judges and supplies the reason Jev doesn't give (`judge: 'sol'`, with Jev's confidence kept when it was consulted).

The card and panel show the judge and confidence ("judged by Jev 91%", "judged by Sol · Jev 55%"). Judgments count against the same global/role daily budgets; exhausted budgets record `ignored` with reason `budget`. A failed judgment records `ignored` with the error as its reason and surfaces a notice, without failing the agent's run. Every five minutes, read notes from stopped/failed runs without a close-out become `ignored`; never-read notes in concluded conversations become `unread`; notes arriving after the last final answer become `late` once concluded or idle beyond `idleMs` with no later run. Notes dismissed before delivery do not count as delivered and get no agent response. Automatic resolution never overrides a user close.

Read-only `stats {days?: number}` (default 7) counts retained notes created within the window, per role: model-visible deliveries, reads, response statuses, pending responses and user dismissals. Archived notes still count until pruned.

`feedback` also accepts a dismissal `reason` (`false-alarm`, `handled`, `wont-fix`) and `snoozeUntil` (a future timestamp at most 30 days ahead, or null to clear). User closes record who/when; reopening clears closure and archive metadata. User-only `manage {do, notes? | conversation?, role?, status?, olderThanDays?, reason?}` requires explicit note ids or at least one filter. Filters combine and exclude archived notes. Resolve/dismiss touch open notes; reopen touches closed notes; archive touches closed notes only. Dismissing a note before its pending outbox delivery removes it from that delivery, never from the transcript.

## Actions and documents

`config` reads effective settings, layers, trust, rubrics and validation problems. User-only/host `setConfig {scope, config}` replaces a layer's advisor key (`null` removes it); `setRubric {scope, name, text}` writes/deletes a rubric (`text: null` deletes). Project writes require trust. User-only `feedback {note, feedback?, status?}` sets thumbs (`up`, `down`, or null) and/or status (`open`, `resolved`, `dismissed`).

`advisor.state` is on the root conversation, `advisor.ledger` on @ultimate, and private `advisor.runs` stores scheduling/latches/outbox. Every review and skip emits `advisor.reviewed`; delivered entries use `advisor.note`.
