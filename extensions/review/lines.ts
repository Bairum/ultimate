/** The text of a parsed diff's lines by number, on either side: what a comment quotes. Pure and browser-safe. */
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import { excerptOf } from './comments.ts'
import type { ReviewComment } from './comments.ts'

const strip = (line: string | undefined) => (line ?? '').replace(/\r?\n$/, '')

/** Each side's lines the patch shows, by line number, without their line endings. */
export function linesOf(diff: FileDiffMetadata) {
  const old = new Map<number, string>()
  const next = new Map<number, string>()
  for (const hunk of diff.hunks) {
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    for (const part of hunk.hunkContent) {
      if (part.type === 'context')
        for (let index = 0; index < part.lines; index++) {
          old.set(oldLine++, strip(diff.deletionLines[part.deletionLineIndex + index]))
          next.set(newLine++, strip(diff.additionLines[part.additionLineIndex + index]))
        }
      else {
        for (let index = 0; index < part.deletions; index++)
          old.set(oldLine++, strip(diff.deletionLines[part.deletionLineIndex + index]))
        for (let index = 0; index < part.additions; index++)
          next.set(newLine++, strip(diff.additionLines[part.additionLineIndex + index]))
      }
    }
  }
  return { old, new: next }
}

/**
 * A selection as the lines a comment covers: on the side the selection ends on (a range dragged across both sides of a
 * unified diff keeps its numbers, read on that side), with the shown lines between as its excerpt.
 */
export function commentRange(
  diff: FileDiffMetadata,
  range: SelectedLineRange,
): Omit<ReviewComment, 'text'> {
  const side = (range.endSide ?? range.side) === 'deletions' ? 'old' : 'new'
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  const lines = linesOf(diff)[side]
  const shown: string[] = []
  for (let line = start; line <= end; line++) {
    const text = lines.get(line)
    if (text !== undefined) shown.push(text)
  }
  return { file: diff.name, side, start, end, excerpt: excerptOf(shown) }
}
