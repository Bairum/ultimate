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
and subscriptions, with counts for the later gate. Conversation docs are read through the host's exported tokens;
the session-scoped automation and subscription ledgers are read through their list actions.

On open, dream applies a chapter's seed in one commit with `dream.seed.applied` on conversation 1: memories keep
their sources, to-dos get fresh ids, questions become user-owned to-dos naming the old chapter and message id, and a
`dream.deliver` task writes one passive `dream.chapter` entry into @ultimate's conversation. Its text names the old
chapter's read APIs, the three learned lines and the carried counts. Reopening does not reapply those documents.

Automations are recreated through their create action after the commit, with per-name receipts in `dream.seed`.
A seed carries at most one enabled automation per name: building rejects duplicates. The destination starts empty;
before each create, dream checks existing names, so a create committed just before a crash is not repeated when its
receipt is missing. Seed application must finish before users create unrelated automations with matching names.
Project subscriptions are rediscovered, stopped, from trusted `.ultimate/subscriptions` manifests by subscriptions'
own open hook. There is no user-subscription adoption path: each enabled user subscription becomes an
@ultimate-owned “Recreate subscription” to-do rather than a fabricated ledger record.

### Fall asleep and switch

`asleep` refuses without a journal, with open or approved proposals, or while other top-level conversations besides
@ultimate are busy. Names use `chapterName`; an existing name must use `switch`, never overwrite its seed. Chapter
changes are serialized. Each progress update commits separately on the session as `sleep`: `seeding`, `checking`,
`backing up`, `switching`, or `failed`, with the gate checks, backup id or skip reason, error, and timestamp.

The gate writes a real seed and switch journal in a temporary home, starts it through optional `InstanceApi`, and
reads its HTTP actions without a model: root memories, open to-dos (including questions and user subscriptions),
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

`refs.ts` holds the documents and actions: `start`, `end`, `asleep`, `switch` (user-only), `chapters`, `pass`, `journal`, `decide`,
and `stats`, which reads tool calls from `<home>/trace.sqlite` read-only: calls, failures and mean duration per tool,
the 20 most frequent errors, and enabled tools never called in the trace's window (7 days or 200k rows).
