/** Shortcuts: `mod+shift+k`, sequences separated by spaces (`mod+k m`). `mod` is ⌘ on macOS and Ctrl elsewhere. */
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

/** The normalized chord of a key event, such as `mod+shift+k` or `escape`. */
export function chordOf(event: KeyboardEvent): string {
  const key = event.code.startsWith('Key')
    ? event.code.slice(3).toLowerCase()
    : event.code.startsWith('Digit')
      ? event.code.slice(5)
      : event.key.toLowerCase()
  const parts = []
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('mod')
  if (isMac && event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  if (!['meta', 'control', 'alt', 'shift'].includes(key)) parts.push(key)
  return parts.join('+')
}

/** Normalize a written shortcut so it compares equal to `chordOf()` output. */
export function parseKeys(keys: string): string[] {
  const order = ['mod', 'ctrl', 'alt', 'shift']
  return keys
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split('+').map((part) => (part === 'esc' ? 'escape' : part))
      const modifiers = order.filter((modifier) => parts.includes(modifier))
      return [...modifiers, ...parts.filter((part) => !order.includes(part))].join('+')
    })
}

const symbols: Record<string, string> = isMac
  ? { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', enter: '↵', escape: 'esc' }
  : { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', enter: '↵', escape: 'Esc' }

/** Display parts of a shortcut, one array of keys per chord: `mod+k m` → [['⌘','K'],['M']]. */
export function formatKeys(keys: string): string[][] {
  return parseKeys(keys).map((chord) =>
    chord
      .split('+')
      .map((part) => symbols[part] ?? (part.length === 1 ? part.toUpperCase() : part)),
  )
}
