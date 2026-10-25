Offloads large tool outputs to durable project files before they enter model context, keeping a short excerpt and a path for follow-up reads.

Enable with `extensions.enable: ["context-offload"]`. It is off by default. No system prompt section is added.

Model-issued results over 16 KB are stored in `<project data dir>/outputs/<conversationId>/<sanitized-callId>.txt`.
For bash, Pi's `structuredOutput.fullOutputPath` or its `full_output` diagnostic supplies the spill path (including
execution failures), so the durable file includes text Pi already truncated. After copying, the redundant temporary-file diagnostic is removed.
The stored result contains up to the first 60 lines, the last 60 lines, and up to 20 numbered lines matching
`error|fail|panic|warn` (case insensitive), followed by an omitted-line/byte count and full-file path. Images, error state, diagnostics
and existing details are preserved; `details.offload` records `{ path, bytes, lines }`.
Use `read` with offset/limit or `grep`/`rg` on that file to drill in. Reads, nested codemode calls and excluded tools
are untouched. A write or spill-read failure preserves the original output and adds a warning diagnostic.
Each kept line is capped at 300 characters with an omitted-character note. Head, tail and matches have
1,900-, 3,800- and 1,400-byte budgets (about 2 KB, 4 KB and 1.5 KB). Including notes, numbering and the path,
the entire excerpt is at most 8 KB, below the default 16 KB threshold, and must be smaller than the full text.
The path marker is last so it survives bash's tail retention.

`api.ts` exposes `ContextOffload.save(conversation, callId, text)` for optional consumers such as context-hygiene.
It saves full text once at the same stable path, preserving an existing full output on retries or later masking.
Save failures throw; callers must retain the original text. Hygiene can mask old bounded reads even though the
immediate offload hook leaves reads and `details.offloadExempt` outputs untouched.

## Settings

User settings and trusted project settings accept (project overrides user per field):

```json
{
  "contextOffload": {
    "thresholdBytes": 16384,
    "exclude": ["my_tool"]
  }
}
```

`thresholdBytes` must be a positive integer; `exclude` is an array of exact tool names. Settings are read on each
installation's first nontrivial model-issued call and cached until the host's settings reload reinstalls the extension.
Empty and one-byte results skip settings entirely. Invalid settings produce one host notice per installation and
fall back to defaults, not per-result diagnostics.

## UI and retention

Bash, browser, web_search and web_fetch cards compose over their existing renderer with a quiet
**Open full output (310 KB)** button beneath the card. It expands a scrollable plain-text block on demand, with
loading and error states. The user-only `open` action returns at most 4 MB and rejects paths (including symlinks)
outside this project's outputs directory. Larger files remain accessible with bounded `read` calls.
Other tools are still offloaded, but have only the excerpt's file-path marker: the current SDK composes renderers
by exact tool name, not a wildcard.

Files survive restarts. Like uploads, files older than 30 days (mtime) are deleted, along with empty conversation
folders. Cleanup runs when the extension opens; it does not need a server change or a timer. Old transcript markers
may consequently point at removed files; rerun the command if the output is needed again. Cleanup errors are reported
by the host's extension lifecycle diagnostics.

## Tests

Run the offload tests and enablement tests together with:

```sh
pnpm vitest run test/context-offload*.test.ts test/extension-enablement.test.ts
```

## Credits

Inspired by context-mode's sandboxed-output approach and billion-context. Independently implemented; no code copied.
Context-mode is Elastic-2.0 licensed; its source was not consulted or copied.
