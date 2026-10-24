/** Optional structural evidence. Without a probe, repairs requiring syntax proof stay disabled. */
export interface NodeSpan {
  kind: string
  startLine: number
  endLine: number
}

export interface SyntaxProbe {
  nodeChain(lines: readonly string[], path: string, line: number): readonly NodeSpan[]
  enclosingBoundaries(
    lines: readonly string[],
    path: string,
    startLine: number,
    endLine: number,
  ): readonly number[]
  parsesCleanly(path: string | undefined, text: string): boolean
}

const noEvidence: SyntaxProbe = {
  nodeChain: () => [],
  enclosingBoundaries: () => [],
  parsesCleanly: () => false,
}
let probe = noEvidence

/** Install the host's parser; omit the argument to reset to no evidence. */
export function setSyntaxProbe(value: SyntaxProbe = noEvidence): void {
  probe = value
}
export function nodeChain(
  lines: readonly string[],
  path: string,
  line: number,
): readonly NodeSpan[] {
  return probe.nodeChain(lines, path, line)
}
export function enclosingBoundaries(
  lines: readonly string[],
  path: string,
  startLine: number,
  endLine: number,
): readonly number[] {
  return probe.enclosingBoundaries(lines, path, startLine, endLine)
}
export function parsesCleanly(path: string | undefined, text: string): boolean {
  return probe.parsesCleanly(path, text)
}
