/**
 * Hashline engine (no tools or UI).
 * Parse a multi-file input with Patch.parse(input); Patcher({ fs, snapshots })
 * preflights and applies it against a Filesystem and SnapshotStore. For pure
 * single-section work use parsePatch/applyEdits or PatchSection.applyTo.
 * Format reads with formatHashlineHeader/formatNumberedLines, then record the
 * full normalized file and only the displayed line numbers with snapshots.record
 * (or recordSeenLines). The host must likewise record lines displayed in edit
 * results; engine results alone do not prove a model saw them. Recovery handles
 * retained stale tags; MismatchError includes current context and records it.
 * InMemoryFilesystem/InMemorySnapshotStore and NodeFilesystem are ready to use.
 * BlockResolver and setSyntaxProbe inject structural evidence; none is assumed.
 */
export * from './xxhash32.ts'
export * from './apply.ts'
export * from './block.ts'
export * from './clipboard.ts'
export * from './diff-preview.ts'
export * from './format.ts'
export * from './fs.ts'
export * from './input.ts'
export * from './messages.ts'
export * from './mismatch.ts'
export * from './normalize.ts'
export * from './parser.ts'
export * from './patcher.ts'
export * from './prefixes.ts'
export * from './recovery.ts'
export * from './snapshots.ts'
export * from './stream.ts'
export * from './syntax.ts'
export * from './tokenizer.ts'
export * from './types.ts'
