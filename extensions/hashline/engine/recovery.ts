/**
 * Recovers stale section tags by proving that every anchored line still maps
 * to one unchanged, contiguous region in the current file, then replaying the
 * edit against that live content.
 *
 * Recovery fails closed when the target changed or became ambiguous. The
 * patcher then returns a mismatch with fresh context instead of guessing.
 */
import { diffLines as diffLineRuns } from 'diff'
import { applyEdits, findReplacementGroup } from './apply.ts'
import { forkClipboard, commitClipboard } from './clipboard.ts'
import { nodeChain } from './syntax.ts'
import {
  editBrokeParseWarning,
  RECOVERY_EXTERNAL_WARNING,
  RECOVERY_LINE_REMAP_WARNING,
  RECOVERY_SESSION_CHAIN_WARNING,
} from './messages.ts'
import type { SnapshotStore } from './snapshots.ts'
import type { Anchor, ApplyResult, Clipboard, Edit } from './types.ts'

export interface RecoveryArgs {
  path: string
  currentText: string
  fileHash: string
  edits: readonly Edit[]
  /** Shared clipboard register for `cut`/`paste` edits, threaded into the replay apply. */
  clipboard?: Clipboard
}

export interface RecoveryResult {
  /** Post-recovery text. */
  text: string
  /** First changed line (1-indexed) relative to the live `currentText`, or `undefined`. */
  firstChangedLine: number | undefined
  /** Warnings collected during recovery, including the user-facing recovery banner. */
  warnings: string[]
}

function collectAnchorLines(edits: readonly Edit[]): number[] {
  const lines: number[] = []
  for (const edit of edits) {
    for (const anchor of getEditAnchors(edit)) lines.push(anchor.line)
  }
  return lines
}

function getEditAnchors(edit: Edit): Anchor[] {
  if (edit.kind === 'delete') return [edit.anchor]
  // Recovery only ever receives already-resolved edits (no `block`); this arm
  // exists for type-exhaustiveness over the full `Edit` union.
  if (edit.kind === 'block') return [edit.anchor]
  if (edit.kind === 'cut') {
    // Every captured line is an anchor: changed interior content is unsafe.
    const anchors: Anchor[] = []
    for (let line = edit.range.start.line; line <= edit.range.end.line; line++)
      anchors.push({ line })
    return anchors
  }
  if (edit.kind === 'paste') {
    if (edit.at.kind === 'span') {
      const anchors: Anchor[] = []
      for (let line = edit.at.range.start.line; line <= edit.at.range.end.line; line++)
        anchors.push({ line })
      return anchors
    }
    const cursor = edit.at.cursor
    return cursor.kind === 'before_anchor' || cursor.kind === 'after_anchor' ? [cursor.anchor] : []
  }
  return edit.cursor.kind === 'before_anchor' || edit.cursor.kind === 'after_anchor'
    ? [edit.cursor.anchor]
    : []
}

function buildLineMap(previousText: string, currentText: string): Map<number, number> {
  const changes = diffLineRuns(previousText, currentText)
  const map = new Map<number, number>()
  let previousLine = 1
  let currentLine = 1

  for (const change of changes) {
    const count = change.count
    if (change.added) {
      currentLine += count
      continue
    }
    if (change.removed) {
      previousLine += count
      continue
    }
    for (let offset = 0; offset < count; offset++) {
      map.set(previousLine + offset, currentLine + offset)
    }
    previousLine += count
    currentLine += count
  }

  return map
}

/** Values appearing two or more times in `lines`, for O(1) duplicate checks. */
function collectDuplicatedValues(lines: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const value of lines) {
    if (seen.has(value)) duplicated.add(value)
    else seen.add(value)
  }
  return duplicated
}

interface AnchorNeighbors {
  /** Nearest non-anchor line below the anchor's run, or `undefined` at the file edge. */
  before: number | undefined
  /** Nearest non-anchor line above the anchor's run, or `undefined` at the file edge. */
  after: number | undefined
}

/**
 * Nearest non-anchor context line on each side of every anchor, computed in
 * one sweep over the sorted anchor set. Anchors in one contiguous run share
 * both neighbors (the lines just outside the run), so this replaces the
 * per-anchor directional walk across anchored ranges — O(anchors²) on a
 * large block replacement — with one O(anchors log anchors) pass.
 */
function computeAnchorNeighbors(
  anchorLines: ReadonlySet<number>,
  lineCount: number,
): Map<number, AnchorNeighbors> {
  const sorted = [...anchorLines].toSorted((a, b) => a - b)
  const neighbors = new Map<number, AnchorNeighbors>()
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    const start = sorted[i]
    const end = sorted[j]
    const before = start - 1 >= 1 && start - 1 <= lineCount ? start - 1 : undefined
    const after = end + 1 <= lineCount ? end + 1 : undefined
    for (let k = i; k <= j; k++) neighbors.set(sorted[k], { before, after })
    i = j + 1
  }
  return neighbors
}

function validateDuplicateAnchorContext(
  line: number,
  mapped: number,
  neighbors: AnchorNeighbors,
  lineMap: ReadonlyMap<number, number>,
): boolean {
  let checked = false
  const { before, after } = neighbors
  if (before !== undefined) {
    checked = true
    if (lineMap.get(before) !== mapped - (line - before)) return false
  }
  if (after !== undefined) {
    checked = true
    if (lineMap.get(after) !== mapped + (after - line)) return false
  }
  return checked
}

function validateUniqueAnchorContext(
  line: number,
  mapped: number,
  neighbors: AnchorNeighbors,
  lineMap: ReadonlyMap<number, number>,
): boolean {
  const offset = mapped - line
  const { before, after } = neighbors
  if (after !== undefined && lineMap.get(after) === after + offset) return true
  return before !== undefined && lineMap.get(before) === before + offset
}

function validateRemappedAnchorContext(
  previousText: string,
  currentText: string,
  lineMap: ReadonlyMap<number, number>,
  edits: readonly Edit[],
): boolean {
  const previousLines = previousText.split('\n')
  const currentLines = currentText.split('\n')
  const anchorLines = new Set(collectAnchorLines(edits))
  // Precompute once per validation pass: which line values are duplicated,
  // and each anchor's nearest non-anchor context. The per-anchor forms —
  // indexOf/lastIndexOf full-file scans plus directional walks across
  // anchored ranges — are O(anchors×lines) + O(anchors²) and blow up on
  // large block replacements.
  const duplicatedPrevious = collectDuplicatedValues(previousLines)
  const duplicatedCurrent = collectDuplicatedValues(currentLines)
  const anchorNeighbors = computeAnchorNeighbors(anchorLines, previousLines.length)

  for (const [line, neighbors] of anchorNeighbors) {
    const mapped = lineMap.get(line)
    if (mapped === undefined) return false
    if (
      !duplicatedPrevious.has(previousLines[line - 1]) &&
      !duplicatedCurrent.has(currentLines[mapped - 1])
    ) {
      if (!validateUniqueAnchorContext(line, mapped, neighbors, lineMap)) {
        return false
      }
      continue
    }
    if (!validateDuplicateAnchorContext(line, mapped, neighbors, lineMap)) {
      return false
    }
  }

  return true
}

interface RemappedEdits {
  edits: Edit[]
  offset: number
}

function remapEditsToCurrent(
  previousText: string,
  currentText: string,
  edits: readonly Edit[],
): RemappedEdits | null {
  const lineMap = buildLineMap(previousText, currentText)
  if (!validateRemappedAnchorContext(previousText, currentText, lineMap, edits)) return null
  const offsets: number[] = []

  const mapLine = (line: number): number | null => {
    const mapped = lineMap.get(line)
    if (mapped === undefined) return null
    offsets.push(mapped - line)
    return mapped
  }

  const mapAnchor = (anchor: Anchor): Anchor | null => {
    const line = mapLine(anchor.line)
    return line === null ? null : { line }
  }

  const remapped: Edit[] = []
  for (const edit of edits) {
    if (edit.kind === 'delete') {
      const anchor = mapAnchor(edit.anchor)
      if (anchor === null) return null
      remapped.push({ ...edit, anchor })
      continue
    }
    if (edit.kind === 'block') {
      const anchor = mapAnchor(edit.anchor)
      if (anchor === null) return null
      remapped.push({ ...edit, anchor })
      continue
    }
    if (edit.kind === 'cut') {
      // Map every captured line; an unmapped interior line means the
      // content drifted and cannot be moved safely. Uniform offsets keep
      // the mapped range contiguous.
      const start = mapLine(edit.range.start.line)
      if (start === null) return null
      let end = start
      for (let line = edit.range.start.line + 1; line <= edit.range.end.line; line++) {
        const mapped = mapLine(line)
        if (mapped === null) return null
        end = mapped
      }
      remapped.push({ ...edit, range: { start: { line: start }, end: { line: end } } })
      continue
    }
    if (edit.kind === 'paste') {
      let blockStart = edit.blockStart
      if (blockStart !== undefined) {
        const mappedBlockStart = mapLine(blockStart)
        if (mappedBlockStart === null) return null
        blockStart = mappedBlockStart
      }
      if (edit.at.kind === 'span') {
        const start = mapLine(edit.at.range.start.line)
        if (start === null) return null
        let end = start
        for (let line = edit.at.range.start.line + 1; line <= edit.at.range.end.line; line++) {
          const mapped = mapLine(line)
          if (mapped === null) return null
          end = mapped
        }
        remapped.push({
          ...edit,
          at: { kind: 'span', range: { start: { line: start }, end: { line: end } } },
          blockStart,
        })
        continue
      }
      const cursor = edit.at.cursor
      if (cursor.kind !== 'before_anchor' && cursor.kind !== 'after_anchor') {
        remapped.push(blockStart === edit.blockStart ? edit : { ...edit, blockStart })
        continue
      }
      const anchor = mapAnchor(cursor.anchor)
      if (anchor === null) return null
      remapped.push({
        ...edit,
        at: { kind: 'gap', cursor: { kind: cursor.kind, anchor } },
        blockStart,
      })
      continue
    }
    if (edit.kind === 'insert') {
      let blockStart = edit.blockStart
      if (blockStart !== undefined) {
        const mappedBlockStart = mapLine(blockStart)
        if (mappedBlockStart === null) return null
        blockStart = mappedBlockStart
      }
      const cursor = edit.cursor
      if (cursor.kind !== 'before_anchor' && cursor.kind !== 'after_anchor') {
        remapped.push(blockStart === edit.blockStart ? edit : { ...edit, blockStart })
        continue
      }
      const anchor = mapAnchor(cursor.anchor)
      if (anchor === null) return null
      remapped.push({ ...edit, cursor: { kind: cursor.kind, anchor }, blockStart })
    }
  }

  if (offsets.length === 0) return null
  const firstOffset = offsets[0]
  if (!offsets.every((offset) => offset === firstOffset)) return null
  return { edits: remapped, offset: firstOffset }
}

function contextPreserved(
  previous: string,
  current: string,
  path: string,
  authored: readonly Edit[],
  remapped: readonly Edit[],
): boolean {
  const before = previous.split('\n')
  const after = current.split('\n')
  const context = (lines: string[], line: number) =>
    nodeChain(lines, path, line).map((span) => [span.kind, lines[span.startLine - 1]?.trim()])
  for (let i = 0; i < authored.length; i++) {
    const oldAnchors = getEditAnchors(authored[i])
    const newAnchors = getEditAnchors(remapped[i])
    for (const edge of [0, oldAnchors.length - 1]) {
      const old = oldAnchors[edge]
      const next = newAnchors[edge]
      if (
        old &&
        next &&
        JSON.stringify(context(before, old.line)) !== JSON.stringify(context(after, next.line))
      )
        return false
    }
  }
  return true
}

/** Unicode scalar Levenshtein similarity, matching pi-edit's fuzzy::similarity. */
function similarity(a: string, b: string): number {
  const left = Array.from(a),
    right = Array.from(b)
  if (!left.length && !right.length) return 1
  let row = Array.from({ length: right.length + 1 }, (_, i) => i)
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < right.length; j++)
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (left[i] === right[j] ? 0 : 1)))
    row = next
  }
  return 1 - row[right.length] / Math.max(left.length, right.length)
}

function aimedAtAuthoredLines(current: string, authored: readonly Edit[], offset: number): boolean {
  const lines = current.split('\n')
  let budget = 1 << 23
  const identifies = (line: string) => Array.from(line.trim()).length >= 8
  const keptShare = (window: string[], body: string[]): number | undefined => {
    const cost =
      window.reduce((sum, line) => sum + Array.from(line.trim()).length, 0) *
      body.reduce((sum, line) => sum + Array.from(line).length, 0)
    if (!window.length || cost > budget) return undefined
    budget -= cost
    return (
      window.reduce(
        (sum, line) =>
          sum +
          (identifies(line) ? Math.max(0, ...body.map((row) => similarity(line.trim(), row))) : 0),
        0,
      ) / window.length
    )
  }
  for (let start = 0; start < authored.length;) {
    const group = findReplacementGroup(authored, start)
    if (!group) {
      start++
      continue
    }
    start = group.deleteIndices[group.deleteIndices.length - 1] + 1
    const body = group.payload.map((row) => row.trim()).filter(Boolean)
    if (!body.length) continue
    const window = (shift: number) =>
      Array.from(
        { length: group.endLine - group.startLine + 1 },
        (_, i) => lines[group.startLine + i + shift - 1] ?? '',
      )
    const target = window(offset)
    if (!target.some(identifies)) continue
    const kept = keptShare(window(0), body)
    if (kept === undefined) return false
    if (kept < 0.5) continue
    const targetKept = keptShare(target, body)
    if (targetKept === undefined) return false
    if (kept > targetKept + 0.3) return true
  }
  return false
}

function replayRemappedAnchorsOnCurrent(
  previousText: string,
  currentText: string,
  edits: readonly Edit[],
  recoveryWarning: string,
  clipboard: Clipboard | undefined,
  path: string,
): RecoveryResult | null {
  const remapped = remapEditsToCurrent(previousText, currentText, edits)
  if (remapped === null) return null
  if (!contextPreserved(previousText, currentText, path, edits, remapped.edits)) return null
  if (remapped.offset !== 0 && aimedAtAuthoredLines(currentText, edits, remapped.offset))
    return null
  const fork = clipboard === undefined ? undefined : forkClipboard(clipboard)
  let applied: ApplyResult
  try {
    applied = applyEdits(currentText, remapped.edits, {
      ...(fork === undefined ? {} : { clipboard: fork }),
      path,
    })
  } catch {
    // A replay that cannot apply safely falls back to the mismatch reveal.
    return null
  }
  if (applied.text === currentText) return null
  if (
    remapped.offset !== 0 &&
    applied.warnings?.includes(editBrokeParseWarning(applied.firstChangedLine))
  )
    return null
  if (fork && clipboard) commitClipboard(fork, clipboard)
  return {
    text: applied.text,
    firstChangedLine: applied.firstChangedLine,
    warnings: [
      remapped.offset === 0 ? recoveryWarning : RECOVERY_LINE_REMAP_WARNING,
      ...(applied.warnings ?? []),
    ],
  }
}
/**
 * Stateless recovery driver over a {@link SnapshotStore}. Construct once and
 * call {@link Recovery.tryRecover} per stale-tag incident.
 *
 * Recovery maps every stale anchor through unchanged lines from the tagged
 * snapshot to the live text, validates surrounding context, and replays the
 * edit directly on live content. All anchors must move by one consistent
 * offset. A changed, deleted, split, or ambiguous target is rejected so the
 * caller can surface a {@link MismatchError} with current context.
 */
export class Recovery {
  readonly store: SnapshotStore
  constructor(store: SnapshotStore) {
    this.store = store
  }
  /**
   * Attempt recovery. Returns `null` when no path forward is found — the
   * caller should then surface a {@link MismatchError}.
   */
  tryRecover(args: RecoveryArgs): RecoveryResult | null {
    const { path, currentText, fileHash, edits, clipboard } = args
    // Unknown or colliding short tags have no unique recovery base.
    const snapshot = this.store.byHash(path, fileHash)
    if (!snapshot) return null
    const recoveryWarning =
      this.store.head(path) === snapshot
        ? RECOVERY_EXTERNAL_WARNING
        : RECOVERY_SESSION_CHAIN_WARNING
    return replayRemappedAnchorsOnCurrent(
      snapshot.text,
      currentText,
      edits,
      recoveryWarning,
      clipboard,
      path,
    )
  }
}
