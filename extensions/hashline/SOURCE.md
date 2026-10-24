# Hashline engine provenance

E1.2 adds the default-off host tools, adapted edit prompt and cards documented
in README.md. The engine and host safety changes, including the review follow-up,
are listed below. Regression coverage lives in `test/hashline-*.test.ts`.

Vendored from `@oh-my-pi/hashline@18.1.5`, `src/*.ts` (MIT), published by
[oh-my-pi](https://github.com/can1357/oh-my-pi). The engine directory preserves
upstream's module structure. `LICENSE-omp` carries the upstream MIT license and
copyrights of Mario Zechner, Can Bölük, and Stencil Labs.

Fixtures are all 19 JSON files from oh-my-pi commit `0b5c27a`,
`crates/pi-edit/tests/fixtures/hashline/`. Rust references below refer to that
commit. Prompt/grammar reference: `crates/pi-edit/prompts/hashline.md` and
`crates/pi-edit/grammars/hashline.lark` at the same commit. Neither prompt nor
grammar is copied verbatim. The host edit description adapts the prompt, with
concrete range/gap examples and without parser-backed block forms.

## Every local change

- All vendored TS and fixture JSON are formatted by Ultimate's formatter;
  relative imports have explicit `.ts` extensions. Fixture data is unchanged.
- `xxhash32.ts`: independent pure TypeScript xxHash32, seed zero, UTF-8 bytes;
  `format.ts` uses it instead of the Bun hash. Native known tag `0BE8` is tested.
- `lru.ts`: Map-based entry/size-bounded LRU replaces pi-utils in `snapshots.ts`.
- `fs.ts`: Node promises replace Bun reads/writes/existence checks; writes create
  parent directories; missing files retain `NotFoundError` semantics.
- `recovery.ts`: `diffLines` from direct dependency `diff@9.0.0` replaces native
  `diffLineRuns`. Added Rust's enclosing-construct comparison, bounded Unicode
  Levenshtein body-similarity refusal at authored numbers, shifted parse-break
  refusal, and clipboard fork/publish only after successful recovery. Recovery
  constructor uses erasable fields rather than a parameter property.
- `apply.ts`: exported the existing replacement-group detector for recovery;
  renamed one shadowing local. No replacement/repair algorithm changed.
- `syntax.ts`: removed native calls and their hash-keyed caches; a host-settable
  `SyntaxProbe` supplies node chains, enclosing boundaries, and parse evidence.
  Default is no evidence (`[]`, `[]`, `false`). Probe errors propagate.
- `snapshots.ts`: per-store, per-canonical-path identical-no-op counters; clear
  resets them. Relocation deduplicates by text rather than the short tag, retaining
  colliding versions. Existing seen-line storage/union is retained.
- `patcher.ts`: erasable `PreparedSection` fields; renamed path import for lint.
  Third consecutive identical section-body no-op throws; first two carry Rust's
  actionable warning; successful writes/moves/deletes reset counters. Multi-file
  no-ops use the same diagnostic. No-op counters compare literal section bodies,
  not a hash (no collision possibility).
- `patcher.ts`, `messages.ts`: retained upstream's seen-line guard and inline
  reveal, added guarding of whole resolved replace/cut blocks and the Rust
  wide-line refusal (unknown tags now fail earlier at tag resolution). Wide unseen rows require a full read rather than
  a truncated reveal. Mismatch context is recorded as seen (sentinel line 0 keeps
  an empty reveal restrictive); unknown-tag replies name other snapshot paths
  that issued the tag. Hashless sections use current-tag mismatch diagnostics.
- `mismatch.ts`: supports missing-tag and tag-origin diagnostics; existing
  context rows remain the mismatch reply format.
- `tokenizer.ts`: permits embedded `#` in a filename when a valid trailing tag
  disambiguates it (the yadm fixture).
- `messages.ts`, `input.ts`, `recovery.ts`, `apply.ts`: non-mutating sorts where
  lint requires them. `format.ts` rejects an invalid cursor exhaustively.
- `index.ts`: short host API guide and xxHash32 export. Host tools must record
  the lines they actually display, including post-edit previews. Engine result
  objects do not themselves prove the model saw their text.
- `test/hashline-engine.test.ts`: Vitest port of Rust's parse/apply comparisons
  (including `fileOp`, exact warnings, null first-changed line, and legacy error
  prefix removal), patcher fixture harness, snapshot/loop/recovery scenarios,
  synthetic block seam, seen-line/mismatch safety, formatting/streaming, Node FS,
  and hash tests. Tests live under `test/` per Ultimate convention.
- `package.json` / lockfile: `diff@9.0.0` is now direct, reusing the already
  resolved dependency rather than shipping native diff code.

### Host tools and review follow-up

- `server.ts`, `store.ts`, `web.tsx`, README and default-off registration add
  wrapped read/write/edit, bounded rg search, durable provenance/registers,
  transcript snapshot restoration and composed cards. Provenance checkpoints on
  every 64th delta. Read/grep/edit results are offload-exempt.
- The full 32-bit hash now lives in `engine/format.ts`. Engine tag resolution,
  including basename path recovery, requires unique retained provenance. Both
  snapshot stores' `byHash` refuse collisions instead of selecting by recency;
  unknown/aged-out tags and live short-tag/full-hash collisions are mismatches.
- REM and every MV require a live full-hash match; neither stale recovery nor
  the head/tail shortcut authorizes destructive file operations.
- MV refuses an existing destination with a tagged-REM instruction. Filesystem
  adapters write edited content to the new destination before deleting the
  source; failed destination writes leave the source unchanged. Node writes use
  exclusive creation. Snapshot history relocates only after a successful move.
- Seen-line carry uses the authored snapshot's numbers, only when a retained
  live-matching version also exists. Missing provenance carries nothing;
  explicit unrestricted (`seen: null`, verified write) is the only unrestricted
  case. Engine-created host snapshots start restrictive, including any landed
  prefix of a batch whose later write fails. Only actually emitted preview rows
  are added. Write read-back grants
  unrestricted provenance only when it equals the normalized authored content.
- The edit description includes a fenced range replacement and gap insertion
  example, and explicitly requires a colon-ending header before every body.
- Intentional legacy fixture divergences: the two `patcher.json` no-snapshot
  acceptance cases now assert mismatch/no write (listed by exact name in the
  harness). The recovery scenario that previously selected the latest collider
  now asserts refusal. The 541 low-level parse/apply call gate is unchanged.

## Executable call gate

`pnpm vitest run test/hashline-engine.test.ts test/extension-enablement.test.ts`

All 19 fixture files are loaded and their inventory is asserted. Ten files
contain the 541 parse/apply calls used by the Rust parity harness. Name-only
integration scenarios are **not** included in that number. Every non-syntax call
passes; the 42 individually named `needs syntax: structural/parse proof` skips
are enumerated and counted in the test, and printed with the per-file counts.

| Fixture                       | Passing parse/apply calls | Needs syntax |
| ----------------------------- | ------------------------: | -----------: |
| parity_block                  |                        49 |            0 |
| parity_boundary_repair        |                       117 |           36 |
| parity_clipboard              |                        39 |            0 |
| parity_core_contracts         |                        38 |            0 |
| parity_file_ops               |                         8 |            0 |
| parity_format_v2              |                        62 |            0 |
| parity_landing_shift          |                        38 |            6 |
| parity_leniency               |                        93 |            0 |
| parity_patcher                |                        44 |            0 |
| parity_recovery_session_chain |                        11 |            0 |
| **Total**                     |                   **499** |       **42** |

Additional fixture-driven scenarios: `patcher.json` (26), `parity_snapshots`
(13), `parity_hashline_loop_guard` (5), `parity_recovery_session_chain` (11),
`parity_diff_preview` (5), two name-only partial-block cases from `parity_block`,
and one partial empty-register case from `parity_clipboard`. Additional focused
safety/seam tests do not inflate the 541-call count.

## Deferred to v2 (E1.7, tree-sitter block resolver)

These 14 **name-only** `parity_block_replace.json` scenarios require the real
resolver and/or host result rendering. They are separate from the 42 call skips.
The Rust mapping is `tests/hashline_parity.rs::block_replace_cases_resolve_syntax_end_to_end`
unless stated otherwise:

- resolves the inner `if` block (line 2) and replaces its full span
- resolves the enclosing function block (line 1) and replaces the whole construct
- deletes the resolved `if` block (line 2) end-to-end via `CUT N*`
- inserts after an Emacs Lisp top-level macro-style form — no matching Rust assertion
- inserts after an extensionless .emacs top-level form — no matching Rust assertion
- reports the diff for a resolved block edit
- echoes the resolved span in the result text for PUT N*:
- echoes the resolved span in the result text for CUT N*
- rejects a lone closing delimiter (no block begins there) and steers to `SWAP N.=M:`
- suggests the next block opener for a blank anchor without modifying the file
- suggests the enclosing block and exact statement range without modifying the file — no matching Rust assertion
- rejects a block edit on an unrecognized language
- CUT N* at a `## H2` deletes the entire section, including nested subsections — no matching Rust assertion
- PUT >N*: at a `## H2` lands after the whole section, past nested subsections — no matching Rust assertion

Also deferred: Rust's additional `block_cut_on_leading_go_statement_keeps_following_siblings`
scenario (not an additional JSON case). V1 tests fixed-span `BlockResolver`
replace/cut/after, unresolved-block errors, after-block fallback and its warning,
whole-span seen-line checks, and tolerant streaming drops. No real syntax proof
is claimed by those synthetic tests.

## Host integration scenarios (out of scope for this engine)

- `parity_coding_agent_hashline.json`: notebook virtual cells/BOM conversion,
  write-tool routing, compact result/diff rendering, path-policy privilege gates,
  local/internal URLs, plan sandbox recovery, and plan-mode working-tree refusal
  belong to the coding-agent/host. The engine parts (BOM, no-op, original-number
  same-path merge, preflight, duplicate targets, recovery and basename redirects)
  are exercised by the executable patcher fixtures and focused engine tests.
- `parity_seen_line_guard.json`: raw/range/multi-range/byte-capped read output,
  ACP bridge blank/range reads and search-produced provenance need the host read
  and grep tools. Engine tests cover snapshot seen-line union, unseen rejection,
  same-tag reveal retry, reveal cap, wide-row refusal, block-span guarding and the
  enforcement switch. There is no ACP bridge in this port.
- `parity_edit_streaming_preview.json` (14 name-only scenarios): ToolSession
  streaming/final preview batches, live Myers diffs, digest extraction and result
  rendering are host plumbing (`hashline_streaming_preview_cases_preserve_partial_and_final_contracts`).
  The engine's existing `applyPartialTo`/`parsePatchStreaming` remain available
  and have focused tests; no ToolSession preview API is claimed.
- `parity_streaming_matcher_paths.json` (7 cases plus upstream `skipped` entries):
  coding-agent rule inspection/path and payload-digest extraction
  (`hashline_inspection_matches_streaming_matcher_cases`) is not an engine API.
  Its fixtures are retained for the tools task, not silently treated as passes.
- Upstream top-level `skipped` metadata for coding-agent TypeScript rule-manager,
  settings/URL/LSP integrations remains out of scope. Server/web facets, default-off
  registration and an adapted prompt are present; LSP, notebooks and path policy
  are not added.

The current Rust engine also has a newer shifted-seen-anchor rescue heuristic
(`rescue_shifted_anchors` in `patcher.rs`) not represented by these parity calls.
By agreement for E1.1, this port conservatively reveals/rejects those unseen
anchors rather than claiming they were displayed. Consider this optimization
only if the A/B shows excessive retries. Host post-edit-preview provenance carry/union
is implemented in `store.ts`/`server.ts`, with the review's stricter rule that
missing live provenance never unlocks unseen lines. The deferred rescue optimization
can require an extra read; it is not permission to guess at moved anchors.
