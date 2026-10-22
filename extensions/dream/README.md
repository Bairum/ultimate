Dream: a working session in which Ultimate processes what it learned, like people do while they sleep. The process,
for @ultimate and the dream branch, is in [DREAM.md](DREAM.md); this file is the mechanics.

## Flow

1. The user presses **Dream** (Memory panel header or ⌘K "Dream…"). The modal shows what blocks a start, live from the
   conversation list and `dream.sessions`: conversations at work besides @ultimate, or a session still open. The
   session's started card has End session until its journal is filed, so a dream that stopped early never blocks the
   next one.
2. User-only `start` refuses the same way, records session N in `dream.sessions` on conversation 1 and submits a
   `dream.started` input to @ultimate (request id `dream.started:N`, a follow-up when it is busy). The input goes
   through a `dream.deliver` task created in the session's own commit, so a crash cannot strand a session.
3. @ultimate starts one branch that runs the five passes (memory, failures, tools, corrections, codify) as
   `dream-pass` subagents (`agents/dream-pass.md`), reporting each with `pass`. Its first report names it the
   session's `dreamer`.
4. The branch files the journal with `journal`: exactly three `learned` lines, Markdown `text` and the proposals. It
   writes once per session: a second call, even after the session ended, returns the filed journal. A passive
   `dream.journal` entry (request id `dream.journal:N`, delivered the same way) goes into @ultimate's conversation;
   its model text lists the proposal ids.
5. The branch answers @ultimate with a `Decisions:` block. @ultimate records each decision with `decide`: `approved`
   with the branch doing it, `applied` (a memory change it made with `remember`) or `rejected`.
6. Reactor `dream/landed` marks approved proposals `landed` with the sha when their branch's submission lands. A
   session ends once its journal is filed and no proposal is open or approved; the user can `end` it earlier.

Nothing here edits code, memory or storage. Phase 2 (a new chapter: a fresh database seeded from the session) is
not built.

## Actions

`refs.ts` holds the documents and actions: `start` and `end` (user-only), `pass`, `journal`, `decide`,
and `stats`, which reads tool calls from `<home>/trace.sqlite` read-only: calls, failures and mean duration per tool,
the 20 most frequent errors, and enabled tools never called in the trace's window (7 days or 200k rows).
