# Dreaming

Like people, agents need time to process what they learned. A dream is a working session: Ultimate reads back over
the project's conversations, memory, failures and tools, writes a journal of what it learned, and proposes changes.
The user decides each proposal with @ultimate; approved ones become ordinary branches, and the dream follows them
until they land. Nothing changes code, memory or storage by itself.

Session N lives in the `dream.sessions` document (`refs.ts`) on conversation 1: read it with codemode
`ultimate.doc('dream.sessions', 1)`. Actions, called with codemode
`ultimate.action('dream', name, args)`: `pass {session, pass, status, note?}`, `journal {session, learned, text,
proposals, chapter?}`, `decide {session, proposal, status, branch?}` and `stats` (tool numbers from the trace, no model). The trace keeps only about the last 7 days, so
`stats` and `ultimate.trace` see only that window, and `stats` counts only tool calls; older failures and model
errors are found in conversation entries.

## For @ultimate

A `dream.started` input means the user pressed Dream. Start one branch with `branch`, prompt:

> Dream session N. Follow "For the dream branch" in the clone's extensions/dream/DREAM.md.

Name the memory slugs the user cares about most in it, always including the memory about the user (`about-<name>`).
The branch answers you with the journal's proposals as a `Decisions:` block; its card is already in your conversation.
Relay the decisions to the user. For each answer:

- **Approved code, prompt or doc change:** start a branch for it (it is ordinary work: assess or build, review, land),
  then `decide {status: 'approved', branch}`. The dream marks it landed when that branch lands.
- **Approved memory change:** apply it with one `remember` batch, then `decide {status: 'applied'}`.
- **Rejected:** `decide {status: 'rejected'}`.

A codified memory (`retire` on the proposal) stays until its branch lands; then delete or update it with `remember`.
The session ends by itself once every proposal is settled; the user can also end it from the journal card.

## For the dream branch

You coordinate the dream. You change nothing: no code, no memory, no settings. You read, analyse and propose. The
dream's own bookkeeping (`pass`, `journal`) is part of the job, not a change.

1. Run the five passes in parallel, each as a `dream-pass` subagent (background), with the session number, its pass
   name and the brief below. Before starting each, call `pass {session, pass, status: 'running'}`; when it reports,
   `pass {…, status: 'done', note}` with a one-line note (or `failed` with the reason).
2. Check each report against its evidence; drop what does not hold up.
3. Merge them into the journal and file it with `journal`: `learned` is exactly three short lines in Ultimate's own
   voice ("I learned…", "I keep…", "I'd like…"); `text` is Markdown with one section per pass; `proposals` lists each
   proposed change once: `id` (a slug), `pass`, `title` (one line saying what changes), `size` (S/M/L), `risk`, and
   `retire` (the memory slug it makes redundant) for codify proposals. Propose `chapter`, a 2–3 word lowercase,
   dash-separated name for the next chapter, drawn from what this dream learned (at most 40 characters).
4. Answer @ultimate with the proposals as one `Decisions:` block, one numbered item per proposal (`(a) do it; (b)
skip.`), each naming its id, then `My picks:`.

### The passes

Every pass reads with codemode (`ultimate.entries`, `ultimate.search`, `ultimate.conversations`, `ultimate.trace`),
`memory`, `git log` and the code. Every claim cites `#conversation/entry`, a trace error, a commit or `path:line`.
Conversation summaries and abstracts (in the root's tally, `ultimate.entries(<root>)`) are the cheap way in; open a
conversation only where they point at something.

- **memory** — distil the project memory: memories that are outdated, contradicted, duplicated or too vague; lessons
  that later conversations taught but nobody remembered. Output add/update/delete ops, each with reason and evidence
  (the memory review in extensions/lineage/README.md). Never drop or weaken the memory about the user.
- **failures** — what failed often: `watchdog.failure` cards, tool and action errors in the trace, retries, reactor
  failures, lander rejections, runs the user had to stop. Group by cause; for the top ones propose a fix.
- **tools** — `stats` gives calls, failures, mean duration and enabled tools never called. Explain the numbers: why a
  tool fails, which are slow, which unused ones should be taught or removed, what agents did by hand that a tool
  should do.
- **corrections** — what the user had to say more than once, corrections of the agents' work, and the wishes: what
  Ultimate itself would like to have or be able to do, from friction seen in old conversations.
- **codify** — memories that should stop depending on being remembered and become how the harness works. For each
  candidate propose one of: code (a behaviour or default), a lint rule or check (only enforcement the user asked for;
  `no-guards` keeps most rules in prompts), agent definitions or docs (an instruction rather than a project fact), or
  stays a memory (context about the project or the user). Say the memory delete or update that follows once it is
  codified.
