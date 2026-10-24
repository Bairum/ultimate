Hashline adds snapshot-tagged reads, line-addressed edits and editable grep results, off by default.

Enable with `"extensions": { "enable": ["hashline"] }` in settings. Disabling it restores Pi's normal read/edit/write tools. The coding-tools extension is unchanged: hashline wraps its tools and composes over its cards.

Read or grep prints `[path#TAG]` and `N:TEXT` rows. Copy the latest header into an edit; line numbers always refer to that original snapshot. `PUT N.=M:` replaces a range, `PUT <N:`/`PUT >N:` inserts, and `PUT >$:` appends. Body rows are `+TEXT` (`+` for blank). `CUT` and register pastes move text; `REM` removes a file and `MV destination` moves it. Use write to create a file. Parser-backed `*` forms are not available yet; use concrete ranges.

Edits preflight all sections before writing, then return new headers and compact numbered previews. Reads preserve Pi's text caps, continuation notes and image handling. Grep uses installed `rg --json`, with pattern/path/glob/ignore-case/context options, at most 100 matches and 20 files; narrow a capped search.

Full snapshot text lives in a bounded process cache (16 conversations, each using the engine's 256-path/four-version/64 MiB bounds). `hashline.provenance` is a rewindable, fork-as-of conversation document containing absolute-path versions, full 32-bit hashes, compact seen-line ranges and registers. A short-tag collision is rejected before the engine can write. After restart a live tag still works with durable seen-line restrictions; stale tags can recover only when their text is cached or a full successful read in the active transcript can rebuild it. Partial reads cannot rebuild full snapshots.

Read, grep and edit results set `details.offloadExempt = true`: their output is already bounded, and downstream offloading must not shorten away rows recorded as displayed.

Only displayed, complete rows count as seen. Edit results carry unchanged rows only when their old and new line numbers agree, plus their displayed preview. Nested/codemode reads cache text without granting displayed-line provenance; nested edits intentionally bypass the seen-line guard because the program computed its anchors. Tags and collision checks still apply.

The read card shows clean code and gutter numbers, not the model's `N:` prefixes. Edit cards show per-file unified diffs; warnings and recovery notices use tool diagnostics. Grep cards group numbered excerpts per file.

## Credits and boundaries

The engine and fixture provenance are in [SOURCE.md](SOURCE.md); MIT copyrights and license are in [LICENSE-omp](LICENSE-omp). The edit description adapts oh-my-pi's `crates/pi-edit/prompts/hashline.md` at commit `0b5c27a`, by Mario Zechner, Can Bölük and Stencil Labs. Its earlier TypeScript engine is `@oh-my-pi/hashline@18.1.5`.

No parser, notebook conversion, LSP, plan-mode policy or internal-URL filesystem is introduced here. File operations use Pi's execution environment, including its remove/rename capabilities. Preflight prevents parse/tag failures from partially writing a batch; filesystem write failures are not transactional and report any already-written prefix. Like other filesystem tools, a separate external writer can still race between validation and commit.
