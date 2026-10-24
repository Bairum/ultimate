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

The session flow does not edit code or memory. Once its journal is filed and every proposal is settled, the user can
call `asleep { session, name? }` to start a new chapter. The name defaults to the journal's proposed `chapter`.

## Dream after compaction

When @ultimate's own context compacts, a dream starts by itself (`after-compaction.ts`). Dream ships the trigger as an
ordinary event automation, **Dream after compaction** (`conversations.compacted where conversation=@ultimate`,
subscriber @ultimate), made once per chapter when the harness opens or @ultimate first starts; its id is kept in
`dream.after-compaction` on conversation 1. It shows in the Automations panel like any other: pausing it stops the
dreams, deleting it is remembered (dream does not make it again), and a new chapter makes it again only as the seed
carried it (paused stays paused). `@ultimate` in the filter resolves to @ultimate's conversation when the event
comes, so it follows @ultimate across chapters; a tally compaction from a root's footer is another conversation and
never matches.

- **Start.** Reactor `dream/after-compaction` sees `automations.fired` of that automation only (its id in dream's own
  document) and creates one durable `dream.after-compaction` wait, unless one already waits, a session is open, a
  sleep is under way or a chapter change holds the lock. The wait looks every 15 seconds until no top-level
  conversation other than @ultimate works, then starts the session through `startDreamIn` (every refusal of the Dream
  button applies; a refusal looks again). After two hours it gives up and leaves @ultimate a quiet note through
  lineage's `leaveNote`. The session records `afterCompaction {automation, name, at, handsOff?}`. No grant is needed:
  the user decided this read-only analysis runs by default; the user-only `start` stays user-only.
- **Deciding.** The `dream.started` input says whether the user granted `dream` on that automation (`handsOff`); only
  then does @ultimate decide the proposals itself, recording each with `decide {…, reason}` (the journal shows it).
  Otherwise the user decides, as for any dream. The rule lives in DREAM.md and `agents/ultimate.md`.
- **Worth a fresh chapter?** When the session settles (the journal filed and every proposal rejected, applied or
  landed; through `journal`, `decide` or a landing), a `dream.settled` task counts its changes: proposals `landed` or
  `applied`. Below `dream.asleepAfter` (settings, project over user, default **5**) we stay in this chapter. At or above
  it, an `asleep` grant on the enabled automation goes through the granted Fall asleep (`grantedSleep`, every gate);
  otherwise, or when that grant is refused, @ultimate is asked to ask the user, and the `dream.settled` card carries
  the Fall asleep section. The outcome is kept as `afterCompaction.outcome`; only `ask` wakes @ultimate, the others are
  passive entries. A session the user ended early never settles this way. Nothing here switches chapters without the
  `asleep` grant or the user's tap.
- **Continuing.** The seed of a compaction's dream carries @ultimate's newest compaction summary as `continues`
  (Pi's wrapper and the project memory lineage appends stripped; at most 12,000 characters, about 3k tokens, beside the
  6,000-token memory brief). The new chapter's wake-up entry quotes it and tells @ultimate to continue that work.

The user's Dream button and ⌘K "Dream…" are unchanged.

## Chapters

A chapter is one database of a project home; one is active at a time and the others stay live, so any chapter can be
made active again (`lib/chapters.ts`).

- The first chapter, `the-beginning`, is the home itself: `<home>/state.sqlite` and `trace.sqlite`. A home that never
  switched has no `chapters.json` and nothing moves. Later chapters live in `<home>/chapters/<name>/`.
- `<home>/chapters.json` `{ active, chapters: [{ name, createdAt? }] }` lists them in creation order; the newest is
  the last.
- A switch is journaled: `requestChapter(home, name)` writes `pending-chapter.json` `{ to }`, then the host restarts.
  `prepareHarness.open` finishes the journal before storage opens: a new chapter gets its database, with record ids
  continuing after every earlier chapter's, so `#123` names one conversation whichever chapter is open. An
  interrupted switch finishes on the next open.
- `requestChapter` refuses while the target chapter has a live foreground task: that work would resume the moment it
  opens.
- The host exposes the active chapter as `host.chapter` (`name`, `number`, `newest`, `dir`, `database`, `trace`).
- Cloud backups are per chapter: the first chapter keeps the project key and `<home>/cloud-backup.json`; a later one
  backs up as `<key>@<name>` with its record in its own folder. The status line names a later chapter.
- `pnpm reset` moves every chapter aside with the first.

### Seed

`seed.ts` builds a JSON manifest with `buildSeed(host, session)` and atomically writes it with
`writeSeed(chapterDir, seed)` to `seed.json`. It carries the journal and proposal statuses, every root's memories
(slug collisions keep the newest `updated`, including `about-*`), open to-dos and questions, and enabled automations
and scripts, with counts for the later gate. The built-in Dream after compaction automation is not among them: the seed
says only whether it was enabled (`afterCompaction`), and the new chapter makes its own. Conversation docs are read through the host's exported tokens;
both trigger kinds are read through the single automations list action. Enabled schedule records keep name, optional prompt, schedule and run profile, but no subscribers: conversation ids do not survive a chapter. Schedules without a prompt become recreation to-dos.

On open, dream applies a chapter's seed in one commit with `dream.seed.applied` on conversation 1: memories keep
their sources, to-dos get fresh ids, questions become user-owned to-dos naming the old chapter and message id, and a
`dream.deliver` task writes one passive `dream.chapter` entry into @ultimate's conversation. Its text names the old
chapter's read APIs, the three learned lines and the carried counts. Reopening does not reapply those documents.

Automations are recreated through their create action after the commit, with per-name receipts in `dream.seed`.
A seed carries at most one enabled automation per name: building rejects duplicates. The destination starts empty;
before each create, dream checks existing names, so a create committed just before a crash is not repeated when its
receipt is missing. Seed application must finish before users create unrelated automations with matching names.
Project scripts are rediscovered, stopped, from trusted `.ultimate/automations` manifests by automations'
own open hook. There is no user-script adoption path: each enabled user script becomes an
@ultimate-owned “Recreate script” to-do rather than a fabricated ledger record.

### Fall asleep and switch

`asleep` refuses without a journal, with open or approved proposals, or while other top-level conversations besides
@ultimate are busy. Names use `chapterName`; an existing name must use `switch`, never overwrite its seed. Chapter
changes are serialized. Each progress update commits separately on the session as `sleep`: `seeding`, `checking`,
`backing up`, `switching`, or `failed`, with the gate checks, backup id or skip reason, error, and timestamp.

The gate writes a real seed and switch journal in a temporary home, starts it through optional `InstanceApi`, and
reads its HTTP actions without a model: root memories, open to-dos (including questions and user scripts),
automations, @ultimate's `dream.chapter` entry, and the memory brief's tokens. Passive delivery gets up to ten
seconds to settle. Lineage only publishes `briefTokens` once a root has branched, so the gate uses `estimateTextTokens`
on the fresh root's index and read instructions (the `memoryBrief` format, with no recent landings); a regression test
compares the formats. Memory briefs have no lineage cap, so the gate uses **6000 tokens**, matching lineage's tally
catch-up envelope. The instance always stops and the scratch home is removed. A failed gate gets exactly one seed rebuild and recheck; two failures stay in the current chapter.

After the gate passes, optional `CloudApi` takes a final non-forced backup of the current chapter. Missing, off or
local-only cloud records why it was skipped; a configured backup failure aborts. Only then is the seed written in
the real destination, the switch journal requested, and the host restarted. A restart failure removes the pending
journal and records `failed`; the seed remains available to retry. No action performs a real switch in its caller.

`chapters` returns `{ active, number, newest, chapters: [{ name, number, createdAt? }] }`. User-only `switch { chapter }`
refuses active or unknown names, busy conversations here, and targets with work in flight (`requestChapter`). It
journals and restarts without building a seed or backing up. A failed restart removes its pending journal and throws.
A successful restart never returns: the new host opens the requested chapter.

## Actions

`refs.ts` holds the documents and actions: `start`, `end`, `asleep`, `switch` (user-only), `chapters`, `pass`, `journal`, `decide` (with an optional one-line `reason`),
and `stats`, which reads tool calls from `<home>/trace.sqlite` read-only: calls, failures and mean duration per tool,
the 20 most frequent errors, and enabled tools never called in the trace's window (7 days or 200k rows).

## Granted by an automation

The user can grant an automation `dream` and, separately, `asleep` (`extensions/automations/README.md` "Grants"). Dream
provides the `automations.dream` point for them; the user-only actions stay user-only.

Both run inside automations' `act` transaction, so the effect commits with the act's record.

- `start(tx, by, acting)` is the Dream button's own path (`startDreamIn`), with the same refusals; only the acting
  conversation's own turn does not count as busy. The session records `by`, and its started card names the automation.
- `asleep(tx, by, {session?})` checks the session (a filed journal, every proposal settled, no sleep under way),
  reserves it as `waiting` for this attempt and creates the durable `dream.granted-sleep` task. The task looks every
  15 seconds, for up to 30 minutes, until no conversation works (the acting agent's turn included), then admits and runs
  every gate of Fall asleep exactly as the user's action does: idle, seed, scratch preview with one repair, final
  backup, idle again, journaled restart that rolls back on failure. While it waits, neither the user nor another grant
  can start a second sleep of that session. A wait that runs out, a refusal or an abort records a failed sleep, but only
  while this attempt still holds it; nothing switches. The task's step commits the admission itself, then leaves only
  the gates running, so a successful switch's restart never waits on a task step and no reservation outlives its task.
  The sleep and the seed carry `by`, so the progress, the outcome and the next chapter's morning card say which
  automation fell asleep, under the user's grant, and when.

On open, a sleep a restart stopped during its gates (`seeding`, `checking`, `backing up`), for the user or a grant,
becomes `failed`: nothing switched, and Fall asleep can be tried again.
