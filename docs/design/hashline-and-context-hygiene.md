# Hashline edits and context hygiene

Status: design draft for review (conversation #8240). Nothing here is built yet.

Sources studied:

- oh-my-pi at `0b5c27a` (2026-10-22, MIT, © Mario Zechner, Can Bölük, Stencil Labs), cloned to `/tmp/omp-audit`.
- `@oh-my-pi/hashline@18.1.5` (npm, MIT, 2026-09-03): omp's TypeScript hashline engine, published before the Rust port.
- `@oh-my-pi/pi-natives@18.12.6`, `pi-hashline-edit-pro@7.0.0`, `billion-context@0.1.206` and `context-mode@1.0.169`,
  unpacked in `/tmp/pkgs`.

All counts, sizes and pass rates below were measured on this machine unless marked as a claim.

## Summary

- **Most of the 100 MB is not hashline.** `pi-natives` is omp's whole native layer: a bash shell, ripgrep, PDF,
  images, tokenizer tables, PTY, audio, text prediction and 17 tree-sitter grammars. The hashline engine is about
  7.9k lines of Rust (`crates/pi-edit/src/modes/hashline/`). Around it sit roughly 3k lines of store, session and text
  code, plus block resolution in `pi-ast` (about 1.8k lines).
- **A port is very viable, because omp wrote it in TypeScript first.** `@oh-my-pi/hashline@18.1.5` is a 7.2k-line
  TypeScript engine (MIT). Today's Rust tests are byte-for-byte parity cases taken from its test suite, stored as JSON
  fixtures. I ran that package against those fixtures:
  - **536 of 541 calls pass** with tree-sitter available;
  - **499 of 541 pass** with the syntax probe stubbed out.

  Its runtime ties are small: `Bun.hash.xxHash32`, `Bun.file` and `Bun.write`, an LRU helper, and three native
  functions (one line diff and two tree-sitter queries). All of these can be replaced.

- **Recommendation:**
  - Vendor and adapt the TypeScript engine into a self-contained `extensions/hashline/`.
  - Keep omp's Rust JSON fixtures as the executable spec.
  - Add tree-sitter (`web-tree-sitter` plus a small grammar set) in a second step.
  - Don't ship the 100 MB package, and don't build a slim native addon.
- **Context hygiene is three independent extensions over one cache-aware rewrite ledger:**
  - `context-hygiene`: superseded reads and empty results;
  - `output-offload`: large outputs stored durably, a short excerpt in context;
  - `context-compress`: model-called compress and decompress.

  None of them changes stored history; each changes only what a request sends, deterministically, so the prompt
  cache breaks at most once per decision.

---

## A. The 100 MB question and porting viability

### What makes up `pi-natives`

The darwin-arm64 addon `pi_natives.darwin-arm64.node` is 100,424,640 bytes. `size -m` reports 54.8 MB of machine
code (`__text`) and 31.7 MB of constant data (`__const`). `crates/pi-natives/Cargo.toml` links:

| Area                             | Crates / data                                                                                                                                             | Rust source lines |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Embedded bash shell and builtins | `pi-shell`, `pi-builtins` (a patched `brush` fork plus in-process utilities)                                                                              | 41.5k + 112.4k    |
| N-API surface and features       | `pi-natives` itself: grep, PTY, clipboard, image, SVG, sixel, PDF inspection, HTML→Markdown, syntect highlighting, snapcompact, OAuth helpers, tokenizers | 110.7k            |
| Tokenizer and prediction tables  | `data/*.bin.zst` (cl100k, o200k, qwen3, kimi, glm5, deepseek3, jev, ctok) and `pi-predict/data/web-prior.bin.zst`, about 8 MB compressed                  | n/a               |
| Tree-sitter                      | `pi-ast` with 17 linked grammars (bash, c, cpp, css, diff, go, html, java, js, json, md, python, regex, rust, toml, ts, yaml) plus a wasm loader          | 6.1k + grammars   |
| Other                            | `pi-vcs` 13.9k, `pi-walker` 7.3k, `pi-vfs` 6.5k, `pi-iso` 4.8k, `pi-voice` 3.7k, `pi-predict` 8.3k, vendored grammar sources 68k                          |                   |
| **Edit engine**                  | `pi-edit` 24.4k, of which the **hashline mode is 7.9k**                                                                                                   |                   |

The rest of `pi-edit` is other edit formats Ultimate doesn't need (`sloppy` 4.9k, `patch` 2k, `apply_patch`
0.5k, `replace` 0.3k), fuzzy matching (1.8k), notebooks (0.6k) and streaming JSON previews (0.8k).

### What the hashline core does (exactly)

Evidence: `crates/pi-edit/src/modes/hashline/*`, `crates/pi-edit/src/store.rs`, `docs/tools/edit.md`, and the
TypeScript package `src/*`.

1. **Tag scheme.** Each file snapshot gets a 4-hex tag.
   - It is the low 16 bits of xxHash32 (seed 0) over the file text, after trimming trailing ` \t\r` from every line
     (`format.ts` `computeFileHash`, `store.rs:79`).
   - The tag covers the whole file, so any read of identical content mints the same tag.
   - An edit section `[path#TAG]` is valid only while the live file still hashes to `TAG`.
2. **Line addressing.**
   - `read` and `grep` print `[path#TAG]` and then `N:TEXT` rows. Partial reads add `…` elision markers.
   - Edits address **original** line numbers of the tagged snapshot. They are never shifted by earlier hunks in the
     same call; the applier resolves all hunks against the original.
3. **Grammar** (`grammars/hashline.lark`). Per file section:
   - `PUT N.=M:` replaces lines N–M with `+` body rows.
   - `PUT <N:` / `PUT >N:` / `PUT >$:` insert before N, after N, or at the end.
   - `CUT N.=M [@reg]` deletes and captures lines.
   - `PUT <N @reg`, `PUT N.=M @reg` pastes a register.
   - `REM` deletes the file; `MV DEST` moves it after the section's edits.
   - Block forms `PUT N*:` and `CUT N*` resolve a syntax node beginning at line N to its end line.
   - Body rows are final content only: `+text`, a lone `+` is a blank line, and `++` / `+-` escape a literal leading
     sign.
4. **Batch semantics.**
   - Every section is parsed and prepared before any write; same-path sections merge.
   - Overlapping ranges are rejected; an exact repeated range coalesces to the later one, with a warning.
   - A byte-identical no-op gets a diagnostic. The third identical no-op in a row is an error (the loop guard).
5. **Boundary repair** (`apply.ts`, about 1.4k lines, the largest part). The applier corrects common model slips:
   - a replacement that repeats an unchanged edge line (a duplicated `}` or decorator);
   - a range that starts one line early on the closer of the construct above;
   - an insertion on an opener that would split a block.

   Each repair is accepted only with proof: exact equality with the rows outside the range, indentation, and, for
   delimiter questions, **a tree-sitter parse of the candidate result**. This is the part that needs a parser
   (42 of the 541 fixture calls).

6. **Stale-tag recovery** (`recovery.rs`, `recovery.ts`).
   - When the tag is not the live file's, the engine looks it up in the snapshot store.
   - It remaps the edit's anchors from that snapshot onto the live text with a line diff (`diffLineRuns`).
   - It applies only when the mapping is unique and safe. It refuses a shift when the body reads as written for the
     current numbers, or when the result breaks a file that parsed before.
   - Otherwise it rejects with the current tag and context rows around the anchors.
7. **Seen-lines guard** (`store.rs` `record_seen_lines`, `session.rs`).
   - Each snapshot records which lines were actually displayed (read windows, grep hits, mismatch context).
   - An anchor outside the displayed lines is rejected with a reveal.
   - Without any recorded read (new process), only anchors on lines longer than the display column cap are rejected.
8. **Snapshot store.**
   - An LRU of 256 paths × 4 versions, up to 64 MB of text; omp's in-process store.
   - It holds full text so recovery can replay edits; registers live there too.
9. **Blocks** (`block.rs` plus `pi-ast/src/block.rs`, 1.35k lines).
   - Tree-sitter finds the multi-line named node starting at the anchor. Decorators and attributes group with the
     first one; a Markdown heading block runs to the next heading of equal or higher level.
   - `PUT >N*:` falls back to `PUT >N:` with a warning; replace or cut forms fail instead of guessing.
   - The engine takes the resolver as a plug-in (`BlockResolver` in `patcher.ts`), so it runs without one.
10. **Grep anchors.** `grep` prints matches in the same `[path#TAG]` / `N:TEXT` form and records those lines as seen,
    so the model can edit straight from search results without a read.
11. **Results.** A successful section returns a fresh `[path#TAG]`, a compact post-edit preview (`diff-preview.ts`)
    and warnings. The model can chain the next edit without re-reading.

### Porting options

|                       | TS port of `@oh-my-pi/hashline` (recommended)                                                                   | Slim native addon from `crates/pi-edit`                                              | Full `@oh-my-pi/pi-natives`                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Fidelity today        | 536/541 Rust parity calls with a parser; 499/541 without                                                        | Same as omp (byte for byte)                                                          | Same as omp; a real edit and a stale-tag recovery run under Node 26         |
| Size shipped          | 7.2k lines vendored (about 250 KB) + fixtures 216 KB; later about 5 MB for `web-tree-sitter` and a few grammars | An estimated 10–20 MB per platform (pi-edit + pi-ast + grammars); not measured       | 100 MB per platform                                                         |
| Toolchain             | None new                                                                                                        | Rust, napi-rs and a 6-platform build and publish pipeline that Ultimate doesn't have | None, but Bun-only loader (`import.meta.dir`); we load the `.node` directly |
| Control and debugging | Plain TypeScript in the repo, readable and patchable                                                            | Rust                                                                                 | Opaque binary pinned to a version                                           |
| Upstream PR to HazAT  | Plausible (self-contained folder, MIT notice)                                                                   | Unlikely                                                                             | Unlikely                                                                    |
| Effort                | About 4–6 working days for engine and integration (below)                                                       | Weeks, plus ongoing release work                                                     | 1–2 days of glue, permanent hack                                            |

**Porting plan (TS):**

1. **Vendor** `@oh-my-pi/hashline@18.1.5` `src/` into `extensions/hashline/engine/`, with `LICENSE` (MIT, omp
   copyright) and `SOURCE.md` (package version, omp commit `0b5c27a` for fixtures, list of local changes).
2. **Replace the runtime ties:**
   - `Bun.hash.xxHash32` → a 60-line pure xxHash32 (tags must match omp's for fixture parity).
   - `Bun.hash` cache keys → plain string keys, or drop those caches.
   - `Bun.file` / `Bun.write` → a `Filesystem` adapter over Pi's `ExecutionEnv` (`readTextFile`, `writeFile`).
   - `LRUCache` from pi-utils → a 40-line Map LRU.
   - `diffLineRuns` → runs computed with `diff` (`diffLines`), already in the tree via other packages; we would add
     it as a direct dependency.
   - `syntax.ts`'s native calls → behind the existing seam. They return "no evidence" in v1 and use
     `web-tree-sitter` in v2.
3. **Port the behaviour that lives in Rust but not in the TS package (about 400 lines):**
   - the seen-lines guard and its reveal messages;
   - the identical-no-op loop guard;
   - the mismatch reply with context rows;
   - the newer recovery refusal heuristics.

   The parity fixtures `parity_seen_line_guard.json`, `parity_hashline_loop_guard.json` and
   `parity_recovery_session_chain.json` define them.

4. **Test plan** (`extensions/hashline/engine.test.ts`, fast and in-memory):
   - Copy omp's 19 fixture files to `extensions/hashline/test/fixtures/` with their license. They hold about 400
     named cases and about 600 parse and apply calls.
   - Port the Rust harness (`tests/hashline_parity.rs`, `hashline_apply.rs`, `hashline_parse.rs`) as a table-driven
     test, which is about 250 lines.
   - v1 gate: every fixture call passes except a listed set that needs a parser, marked `needs: syntax`. The list is
     known today: 36 boundary-repair calls and 6 landing-shift calls.
   - v2 gate: 541/541 plus the block fixtures with a real resolver.
5. **Drop:** the other edit formats, notebooks, streaming JSON previews, path policy and plan mode, internal URL
   schemes, LSP write-through, and the auto-generated-file guard (a possible later addition).

**v1 without tree-sitter, and what it gives up:**

- Block forms (`N*`) are not offered in the prompt and fail with a clear message.
- About 8% of the parity calls (the parse-proved boundary repairs) apply literally instead of being corrected. Those
  are model mistakes that omp silently fixes.
- So v2 (tree-sitter) is a quality step, not polish. It should follow v1 directly, once measurement shows v1 holds
  its own.

---

## B. How omp's engine behaves and why it helps

### Model-facing contract

The prompt (`crates/pi-edit/prompts/hashline.md`, 1,963 characters; compact variant
`packages/coding-agent/src/edit/hashline-compact.md`) is terse and rule-heavy:

- **Header and numbering:**
  - Every section starts with `[PATH#TAG]` copied from the latest read, grep or edit result.
  - Numbers always refer to the original `LINE:TEXT` rows.
- **Ops**, as in A.3.
- **Rules:**
  - Body rows are final content; never send `-` rows or bare context.
  - Touch only displayed, changed lines; elided ranges are unseen.
  - Keep ranges tight and split non-adjacent changes. Never start or end a range mid-expression.
  - Pure additions use gap inserts; deletes use `CUT`, not an empty `PUT`.
  - After every edit the tag and numbers change, so use the edit response or a fresh read.
  - Don't restyle unrelated code.
- **Grammar:** a Lark grammar (`grammars/hashline.lark`) is available for constrained decoding on custom-tool APIs.

Other prompts (`replace.md`, `patch.md`, `apply_patch.md`, `sloppy.md`) describe the other modes. omp switches
hashline off for some model families (Kimi, MiMo, MiniMax, DeepSeek, StepFun, Codex Spark, GLM Flash;
`utils/edit-mode.ts:20-43`), which shows it is not better for every model.

### Why it helps models

- **No recall burden.** Replace-style tools make the model reproduce old text exactly, whitespace included. Hashline
  asks only for a number range and the new text.
- **Cheaper output.** No `oldText` is generated. Output tokens cost about 5× input tokens on Claude, and generation
  dominates latency.
- **Fails safe.** A stale or invented tag is rejected before writing. The reply carries the current tag and the
  surrounding rows, so the retry needs no extra read.
- **Recovers cheaply.** An edit-after-edit with an old tag is remapped when it is provably safe.
- **Repairs typical slips.** Duplicated closers and decorators, off-by-one starts, and openers split from their
  bodies are corrected when a parse proves it.

### Benchmarks

- **Blog post** (claim; blog.can.ac, "The harness problem", 2026-02-12): 16 models × 3 runs × 180 tasks, React files
  with mechanical bug mutations.
  - Hashline beat `patch` for 14 of 16 models.
  - Against `replace` (str_replace) the gains are smaller: Claude Sonnet 4.5 +3.3 pp with −24% output tokens, Claude
    Haiku 4.5 +11.3 pp, Gemini 3 Flash +11.3 pp, GPT-5.2 Codex −0.4 pp with +26% tokens, DeepSeek V3.2 −8.3 pp.
  - That post used an older format with per-line hashes. The current design (one file tag plus line numbers) is
    "v2+", and the post reports v2 improved 12 of 16 models further.
- **In the repo:** `packages/typescript-edit-benchmark` (MIT) holds the task generator and verifier, plus
  `fixtures.tar.gz` with **106 ready tasks**. Each has `prompt.md`, `input/` and `expected/`, and the verifier
  compares results after Prettier formatting. No result data is checked in.
- **`pi-hashline-edit-pro`** reports results on the third-party Explicit Edit Benchmark (226 tasks). It is a
  different design (per-line anchors), included for context only.

**What it means for Ultimate:** the expected win against our current `replace` tool on Claude is a few points of
reliability and roughly 20–30% fewer output tokens per edit, not a step change. Our measured baseline (C.6) already
has a low failure rate.

---

## C. Applying it in Ultimate (equal or better results)

### C.1 Shape

A new optional extension `extensions/hashline/`, off by default and enabled with `extensions.enable`. When it is
loaded it applies to every model, as the user decided. Turning it off restores today's tools.

```
extensions/hashline/
  README.md          how it works, credits, settings
  LICENSE-omp        MIT notice for vendored engine, prompt text and fixtures
  SOURCE.md          upstream versions and local changes
  engine/            vendored TS engine (adapted)
  store.ts           per-conversation snapshot store + durable provenance
  server.ts          wraps read/write, replaces edit, adds grep, prompt section
  web.tsx            renderers composed over coding-tools' cards
  *.test.ts          parity harness + integration tests
  test/fixtures/     omp's JSON fixtures
```

### C.2 Tools, through `wraps`

`Extension.wraps` applies `wrapTool(...)` wherever the extension is selected, so `coding-tools` stays untouched.

- **`read` (wrap).** Call Pi's read and keep its truncation, offset/limit and image handling.
  - For text results: compute the tag from the full file text, record a snapshot with the displayed line set, and
    return `[path#TAG]` plus `N:TEXT` rows.
  - Put `details.hashline = { path, tag, startLine, text }` in the result so the card can render clean code.
- **`edit` (replace through wrap).** The schema becomes `{ input: string }`. Execution:
  1. parse;
  2. per section, read through `api.env`, check the tag against the store and the live text, apply with the engine,
     and write through `api.env.writeFile`;
  3. return fresh headers, compact previews and warnings.

  Details carry `patch` (a unified diff via `diff`), so the existing diff renderer works. The tool is
  `executionMode: 'sequential'`: Pi's `withFileMutationQueue` is not exported, and a sequential call makes its whole
  round sequential, so it cannot race a `write` in the same round.

- **`write` (wrap).** After a successful write, record the snapshot with no seen-line restriction (omp's rule) and
  append `[path#TAG]` so an edit can follow at once.
- **`grep` (new tool).** It runs `rg --json` (ripgrep is already what agents use through bash), then:
  - groups matches per file, reads each matched file once to tag it, and prints `[path#TAG]` plus `N:TEXT` for
    matches and context;
  - records those lines as seen;
  - caps output at 100 matches and 20 files, with a "narrow the pattern" note.

  An empty result sets `details.useless = true`, which phase 1 of context hygiene uses.

### C.3 Per-conversation state across forks and restarts

- **Snapshot texts** live in a process-level, content-addressed LRU (256 paths × 4 versions per conversation). They
  are not durable; they are only used for stale-tag recovery.
- **Provenance** lives in a conversation document `hashline.provenance`, rewindable with fork `asOf`. It holds
  `{ [absPath]: [{ tag, hash32, seen: [[a,b],…] }] }`, with the last 4 tags per path kept.
  - It is small, survives restarts, and a fork inherits it as of the fork entry. That matches the history the
    child sees.
- **After a restart:**
  - If the tag matches the live file, the edit applies normally; provenance still enforces seen lines.
  - If the tag is stale, the snapshot is missing. As a **better-than-omp** step, rebuild it from the transcript: the
    `read` result entry that minted the tag holds the displayed text in `details.hashline.text`. A full read yields
    a complete snapshot; a partial one can't support recovery, so we reject with context.
- **Collision guard (better than omp):** we also store a 32-bit hash. A 16-bit tag match whose 32-bit hash differs
  is treated as stale. This removes the 1-in-65,536 false match.
- **Registers** (`CUT … @name`) live in the same conversation document, so they survive restarts.

### C.4 Interactions

- **Codemode.** `tools.read` and `tools.edit` inside a script run as nested calls (`call.parent` set) in the same
  conversation, so they share the store.
  - A nested read records the snapshot but **not** seen lines, because the model never saw them.
  - A nested edit skips the seen-lines guard: the script's code computed its numbers from text it read.
- **Subagents.** Each child is its own conversation with its own provenance. A `fork: true` child inherits the
  parent's provenance as of the fork.
- **Worktrees.** Keys are absolute paths, so isolated checkouts never collide. Two conversations editing the same
  file in one checkout are protected by the tag check, as today's `oldText` match protects them.
- **External changes** (bash `sed`, a formatter, another agent) change the hash. Recovery remaps when it is safe;
  otherwise the reply gives the current tag and rows.
- **Pi compaction.** Tags in summarised history become unreachable text. Provenance keeps the last 4 tags per path,
  so an edit right after a compaction still validates against the live file.

### C.5 Prompt and UI

- **Tool description:** omp's `hashline.md` adapted (with credit). For v1:
  - drop the `*` block forms and `REM` / `MV` (bash covers delete and move);
  - keep `PUT` ranges, gaps, `>$`, and `CUT` / paste with registers;
  - add one line: "Copy `[path#TAG]` from the latest read, grep, write or edit result."

  It replaces the current `edit` description. The "After Could not find…" hint in `coding-tools` no longer applies,
  because that text belongs to Pi's edit.

- **Renderers** (in `web.tsx`). They compose over `coding-tools` in discovery order: each receives `core` and returns
  it unless the call is a hashline call.
  - **Read card:** the same `CodeBlock`, fed from `details.hashline.text` and `startLine`, so the user sees clean code
    with gutter numbers, never `N:` prefixes.
  - **Edit card:** the title lists the paths from the section headers, and the body is the existing diff rows from
    `details.patch`. Warnings and recoveries appear as `ToolDiagnostics`.
  - **Grep card:** matches grouped by file, using the same `CodeBlock` with line numbers.

### C.6 Measurement

**Baseline**, measured now from stored history. `ultimate.trace()` keeps only about the last hour, so history
(`ultimate.search`) is the source:

| Metric                               | Value                                              |
| ------------------------------------ | -------------------------------------------------- |
| `edit` calls / edit blocks           | 126 / 337                                          |
| `edit` error results                 | 2 (1.6%)                                           |
| Mean `oldText` / `newText` per block | 134 / 274 chars (`oldText` is 33% of edit payload) |
| `read` results / mean size           | 130 / 3,438 chars                                  |

**Expected effect at today's mix:**

- Edit payload falls by about 25–30%: `oldText` is gone, a short header is added.
- Read results grow by about 8–10%, from the `N:` prefixes and the header.
- Output is the expensive side, so cost should fall even though the totals roughly cancel. This is why measurement
  must count output and input separately.

**Method:**

1. **Offline A/B (the decision gate).**
   - Use omp's 106 benchmark fixtures with its verifier, via a small runner. The runner starts an isolated
     Ultimate test instance (`instance start`) per arm: arm A with `hashline` disabled, arm B enabled. The instance
     model is set per run.
   - Each task runs in a fresh temp directory and a fresh conversation.
   - Plan: 2 models (Claude Sonnet class and the Codex model in use) × 40 tasks × 2 runs × 2 arms = 320 runs.
   - Record pass/fail (verifier), output tokens, input tokens, cache read/write, tool calls, edit errors, wall time.
   - If driving instances proves awkward, a headless Pi Durable harness with the same extensions is the fallback.
     That needs a spike.
2. **Field before/after.** Every hashline result carries `details.metrics` (sections, hunks, recovered, rejected
   with reason, payload chars). A codemode report compares 2 weeks before with 2 weeks after: per edit call, error
   rate and retries (an error followed by another edit of the same path within 3 calls).

**Success thresholds (all must hold, per model):**

- Benchmark pass rate is no more than 2 pp below arm A (non-inferiority).
- Edit error rate ≤ 3%, and zero wrong-target writes (the verifier diff touches only the mutated region).
- Output tokens per passed task fall by at least 15%.
- Total cost per passed task is no higher than arm A.

If v1 misses on pass rate, the first suspect is the missing parse-proved repairs (A.5), which v2 adds.

---

## D. Context hygiene: architecture for all three phases

### D.1 Principles

- **Never rewrite storage.** Entries stay as they are: transcripts, `ultimate.search`, compaction input and
  undo all keep the full text. Only the messages a request sends change, via the `GenerationTask` `beforeRequest`
  hook (`pi-durable/dist/harness/types.d.ts:790`).
- **Deterministic and monotonic.** What a request sends is computed from a durable ledger, and a decision, once
  applied, applies to every later request. The cached prefix therefore breaks at most once per decision, at a time we
  choose.
- **Keep the message structure.** Only text content is replaced. Every `toolCall` / `toolResult` pair, role and
  order stays, so providers never see broken pairs.
- **Fail open.** Any error in a hook sends the unmodified request and records a diagnostic.

Why it matters: Pi Durable's compaction trigger uses the **measured** input tokens of the last response plus an
estimate of newer entries (`estimateContext`, `harness/compaction.js:272`). Smaller requests therefore postpone
compaction with no Pi change.

### D.2 Cache-aware gate (shared)

Prompt caching is prefix-based. Anthropic places `cache_control` on the system prompt, the tools and the last
message (pi-ai `compat-schema.js:190`), with "short" (5-minute) retention by default; OpenAI caches automatically.
Changing message _k_ forces the cache to be rewritten for everything after _k_ once.

A pending decision becomes **applied** on a request only when one of these holds:

1. **Cold cache:** more than the provider's retention (5 min short, 1 h long) has passed since the last assistant
   message. The prefix is being rebuilt anyway.
2. **New context:** this is the first request after a compaction or reset.
3. **Cheap suffix:** the tokens after the earliest pending candidate are ≤ 8k and the pending savings are ≥ 2k.
4. **Pressure:** the estimated context is over 60% of the threshold and the pending savings are ≥ 8k.
5. **No caching:** the provider does no caching (no cost to rewrite).

Further rules:

- The newest 16k tokens are never touched (the protect window).
- Applied decisions are committed through `host.harness().commit` from the hook, as `lineage` does in
  `beforeCompact`, before the rewritten request goes out. A retry or a restart then sends the same bytes.
- **Metrics:** the hook records per request the tokens elided, and the next response's `cacheRead` / `cacheWrite`
  usage. That shows in practice whether the gate pays off.

### D.3 Phase 1: `extensions/context-hygiene/`

**Rules** (from omp's `pruneSupersededToolResults` and useless-result elision):

- **Superseded read:** a `read` result of path P is superseded by a later successful `read` of P whose range covers
  it. A full read covers everything; ranges compare by offset and limit, or by hashline details.
  - Not when P was edited between the two reads and the later read is partial.
  - With hashline on, the older tag is dead anyway.
- **Empty result:** `details.useless === true`, set by hashline `grep` with no matches and by tools that opt in.
- **Duplicate result:** an identical tool, arguments and output twice; the older one is elided.

**Data model:** a conversation document `context-hygiene.ledger` (rewindable, fork `asOf`):

```ts
{
  version: 1,
  decisions: {
    [toolCallId]: {
      reason: 'superseded' | 'empty' | 'duplicate',
      by?: string,        // the call that made it redundant
      tokens: number,     // estimated
      state: 'pending' | 'applied',
      at: number,
    },
  },
  stats: { appliedTokens: number, requests: number },
}
```

Tool call ids are stable in both entries and request messages, so mapping is exact.

**Flow:**

1. `afterTools` scans the new results against earlier ones and adds `pending` decisions (cheap: it only needs the
   paths and arguments of earlier calls in the active context).
2. `beforeRequest` runs the gate. It applies pending decisions when allowed and replaces each applied result's text
   with `[Elided from context: superseded by a later read of src/x.ts. Read it again if you need it.]`.

**API for later phases:** `api.ts` exports the ledger token and two helpers, the gate and `rewrite(messages,
transform)`, so phase 2 reuses the same deterministic pipeline (`host.need`).

**UI:**

- Elided tool cards get a quiet "elided from context · 3.2k tokens" tag. A renderer decoration reads the ledger,
  composed over the existing cards.
- Stats: elided tokens and requests rewritten. They go in a small row under the context header if the `context`
  extension offers a slot. Otherwise a ⌘K "Context hygiene" panel. No noise in the transcript.

**Failure modes:**

- The model needs elided text: the placeholder says to re-read, which costs one call.
- The gate rewrites too often: cache writes rise. The metrics show it, and the thresholds are settings.
- A fork or rewind: the rewindable ledger follows the history (`asOf`).
- Pi compaction removes the elided entries: their decisions no longer match any message and are skipped. They are
  pruned on the next `afterTools`.

### D.4 Phase 1b: `extensions/output-offload/`

**Problem:** Pi's bash keeps the last 2,000 lines or 50 KB, about 12k tokens, in context. It spills the rest to a
temp file under `/tmp` that is not durable. Browser and web output have their own limits.

**Design:** an `afterTool` hook (`ToolTask`) on calls the model issued (no `call.parent`; codemode output already
stays out of context) whose text output exceeds a threshold (default 16 KB). It:

1. writes the full text to the project's data directory at `outputs/<conversation>/<callId>.txt`, with the same
   retention as uploads (30 days);
2. replaces the result before it is committed. The new result has: the first 60 lines, a marker line
   (`… 4,812 lines (310 KB) not shown; full output: <path>. Use read with offset/limit, or grep on it …`), the last
   60 lines, and up to 20 lines matching `error|fail|panic|warn` with line numbers.
3. sets `details.offload = { path, bytes, lines }`.

**No new search tool.** The full output is a real file, so `read` (with offset and limit) and `grep` or `rg` reach
it. That is simpler than billion-context's search tool or context-mode's FTS index, which this scale doesn't need.

**Cache and durability:**

- **Cache:** no cost, because the result is shortened before it ever enters context.
- **Durability:** the result entry is committed with the excerpt, and the file outlives restarts.

**UI:** the bash and browser cards get an "Open full output (310 KB)" action through a renderer decoration. It reads
the file via a user-only action.

**Failure modes:**

- The disk write fails: keep the original result and add a diagnostic.
- The file was removed by retention: the marker's path errors on read, and the model reruns the command.

### D.5 Phase 2: `extensions/context-compress/` (model-called, after billion-context)

**Tools:**

- **`context_ranges`:** lists compressible spans, which are whole turns older than the protect window. Each comes with
  an id (the first toolCallId or message timestamp), a token size, a one-line gist (the turn's first user line and
  tool names), and whether it is already compressed.
- **`compress {from, to, summary}`:** the model writes the summary itself, so there is no extra model call. It is
  validated:
  - the range is whole turns, entirely outside the protect window, and doesn't overlap another range;
  - the summary is under 25% of the range's tokens and non-empty.
- **`decompress {id}`:** marks a range inactive.

**Data model:** a conversation document `context-compress.ranges` (rewindable, fork `asOf`):
`[{ id, from, to, summary, tokens, active, at }]`.

**Rewrite:** through phase 1's pipeline. The messages of an active range are replaced by one user message,
`<compressed id="c3" turns="…">summary</compressed>`.

- A compress takes effect on the next request; it is a deliberate model action, so the gate's timing rules don't
  hold it back.
- Because ranges are whole turns, no tool pair is ever split.

**Identity, open point to spike:** request messages carry no entry ids. Turn boundaries are mapped by assistant
`toolCall` ids and message timestamps; the spike must show these are unique and stable in `beforeRequest`. If not,
the fallback is `toolCallId`-anchored ranges only.

**Interaction with Pi compaction:**

- Compression lowers measured usage, so compaction comes later.
- When a compaction cuts past a range, that range is dropped.
- Optional, better than both upstreams: a `beforeCompact` hook returns `{ summary }` built from the active compressed
  summaries when they cover the whole compacted range. That makes the compaction free and keeps the model's own
  wording.

**Prompt section** (short and fixed, so the cache holds): when to compress (after finishing a sub-task, or when
`context_ranges` shows large old turns), and that `decompress` exists.

**UI:**

- `compress` / `decompress` cards show the range, tokens saved and the summary.
- The compressed turns in the transcript get a quiet bracket, "compressed as c3 · saved 18k". Nothing is hidden from
  the user.

**Failure modes:**

- An over-eager model compresses what it still needs: `decompress`, and the metrics (compress followed by decompress
  within 5 turns).
- A poor summary loses details: the transcript and `ultimate.search` still hold everything, and decompress restores
  it.
- The cache breaks on each compress: the cost is visible in metrics, and the prompt asks for few, large compressions.

### D.6 Why not use the packages directly

| Package                 | License                            | Runs under Ultimate?                                                                                                                         | Reason not to use as is                                                                                                                                                                              |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| billion-context 0.1.206 | MIT (core `acp-kernel` MIT)        | No: a local proxy in front of the provider; the pi plugin uses `before_provider_request` and a `127.0.0.1` base URL; state in its own SQLite | Bypasses Pi Durable's storage and compaction; 36 MB minified bundle; 301 open issues. **Idea taken:** model-called compress/decompress (phase 2).                                                    |
| context-mode 1.0.169    | **Elastic-2.0** (source-available) | No: pi-coding-agent extension API, an MCP child process, `better-sqlite3`                                                                    | License blocks copying code into MIT Ultimate; its routing prompt steers away from `read`/`edit`; per-turn memory injection. **Idea taken:** offload large output (phase 1b), written independently. |
| omp pruning             | MIT                                | n/a (inside omp's session code)                                                                                                              | **Ideas taken:** superseded and useless elision, cache-aware timing (phase 1).                                                                                                                       |

---

## E. Upstream-ability

Each piece is its own extension folder with its own README, credits and tests. All are off by default. Nothing is
fork-only and there are no edits to `web/`, `server/` or `coding-tools`.

| PR  | Folder                                                                                   | Depends on                                | Notes                                                                                                |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | `extensions/hashline/` (engine v1, read/write wrap, edit, grep, renderers, parity tests) | none (adds `diff` as a direct dependency) | MIT notice for vendored engine, prompt text and fixtures                                             |
| 2   | `extensions/hashline/` tree-sitter resolver and parse proofs                             | PR 1                                      | Adds `web-tree-sitter` plus about 8 grammar wasm files; enables `N*` and the 42 parse-proved repairs |
| 3   | `extensions/context-hygiene/` (+ `api.ts`: ledger, gate, rewrite)                        | none                                      | Uses `details.useless` when present; no hard dependency on hashline                                  |
| 4   | `extensions/output-offload/`                                                             | none                                      | Reuses the uploads retention pattern                                                                 |
| 5   | `extensions/context-compress/`                                                           | PR 3 (`host.need`)                        | Credits billion-context for the idea (MIT)                                                           |

Fork-only and not offered upstream: the A/B runner and its reports. These live under `.ultimate/` (project tooling),
alongside a short results note.

Commit style: one focused commit per PR-sized unit, each with its own checks green, so a PR is a clean cherry-pick.

## Open decisions

1. **Engine:**
   - (a) TS port of `@oh-my-pi/hashline` with omp's fixtures as the spec;
   - (b) the full `pi-natives`;
   - (c) a slim native addon.
2. **Tree-sitter timing:**
   - (a) v1 without it, then v2 right after, measured separately;
   - (b) include it in v1.
3. **Ops in v1:**
   - (a) ranges, gaps and `CUT` with registers, with no `REM` / `MV`;
   - (b) omp's full set.
4. **A/B budget:**
   - (a) 2 models × 40 tasks × 2 runs × 2 arms (320 runs);
   - (b) all 106 tasks × 3 runs.
5. **Build order:**
   - (a) hashline v1 → measure → hashline v2, while phase 1 and 1b of context hygiene run in parallel, then phase 2
     after its identity spike;
   - (b) strictly one at a time.
