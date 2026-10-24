Hands-off goals: put @ultimate on a goal and go away; it decides what it would otherwise ask you, records each decision with its reason, and leaves a report.

## Flow

1. The user opens ⌘K **Go hands-off…** and writes the goal in their own words (what to reach, and when to stop if
   they want). User-only `start` records goal N in the `goal` document on conversation 1 and submits a `goal.started`
   input to @ultimate (request id `goal.started:N`, a follow-up when busy). Only one goal is open at a time.
2. While the goal is open, every run of @ultimate starts with a `goal.note`: the goal, its criteria with their state,
   and the rule: decide instead of asking, record each decision, keep going. The note is per input, never a
   system-prompt section, so the prompt cache holds. Nothing else switches: the prompts of @ultimate and the
   coordinators point to the note.
3. @ultimate keeps the goal with its deferred `goal` tool (any other caller is refused):
   - `criteria {criteria}` writes what done means, each checkable;
   - `decide {question, picked, reason, conversation?, images?}` records a decision it took for the user, such as a
     branch's go or a UI preview it approved; `images` (`"latest"` or an entry id of its conversation) keeps the
     screenshots it judged;
   - `met {n}` and `failed {n}`: a criterion is blocked after 3 failed tries; work goes on with the others;
   - `finish {outcome: 'met' | 'blocked', summary}` ends the goal.
4. The goal ends when @ultimate finishes it or the user presses **End hands-off** on its card (user-only `end`). Either
   way a `goal.report` card is written into @ultimate's conversation (`goal.report:N`), and from then on it asks the
   user as usual.

There is no budget or rule list: what stays the user's (secrets, logins, force pushes) is already theirs elsewhere,
and the rest is @ultimate's judgement. Pause in the status line stops everything at once, as always.

## UI

- `goal.started`: the goal in the user's words, its criteria (open, met, blocked with failed tries), the latest three
  decisions and **End hands-off**; once ended, it points to the report.
- `goal.report`: the outcome (met, stuck, ended by you), the summary, the criteria and every decision with its time,
  its conversation, what it would have asked, what it picked and why, and any screenshots it judged.
- A quiet **Hands-off** mark in the status line while a goal is open; it opens @ultimate.

## Actions

- `start { text }` → the new goal. User-only.
- `end` → the ended goal. User-only.
- `images { goal, entry }` → the images of a decision's screenshot entry, for the report card.
