/** A path pasted into a prompt: quoted when it holds characters a shell or reader would split on. */
export const quotePath = (path: string) => (/^[\w./~@+-]+$/.test(path) ? path : `'${path}'`)

/** Inserts `addition` at the textarea's cursor (or the end), padded with spaces from its neighbours. */
export function insertAt(text: string, start: number, end: number, addition: string) {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  return {
    text: before + lead + addition + trail + after,
    cursor: (before + lead + addition).length,
  }
}
