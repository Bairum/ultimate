/**
 * How a window is named everywhere: observe, act, teach, practice and the start dialog's picker. Titles from the
 * driver carry invisible characters (Citrix's Edge title is `Microsoft\u200B Edge`), so a title and the fragment
 * matched against it are both compared case-insensitively with format characters removed and whitespace collapsed.
 * Pure: the web imports it too.
 */

/** `Microsoft\u200B  Edge` → `microsoft edge`. */
export function normalizeTitle(value: string) {
  return (
    value
      .normalize('NFKC')
      // Format characters (zero-width spaces and joiners, bidi marks, BOM), soft hyphens and Hangul fillers.
      .replace(/[\p{Cf}\u00AD\u115F\u1160\u3164\uFFA0]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  )
}

/** Whether `title` contains `fragment`, compared normalised; an empty fragment matches nothing. */
export function titleMatches(title: string, fragment: string) {
  const wanted = normalizeTitle(fragment)
  return !!wanted && normalizeTitle(title).includes(wanted)
}

/**
 * The windows `window` names: a number selects that id only; digits as text select that id when one has it, else
 * every window whose title contains the text, as any other text does; no `window` selects all. With `titleOnly`
 * (a saved lesson's or an approval's title fragment, never the model's `window` argument) text matches titles only,
 * so a fragment "2025" never selects window id 2025. Callers refuse anything but one match.
 */
export function selectWindows<
  W extends { window_id?: unknown; title?: unknown; window_title?: unknown },
>(windows: W[], window?: string | number, { titleOnly = false } = {}) {
  if (window === undefined) return windows
  if (typeof window === 'number') return windows.filter((w) => Number(w.window_id) === window)
  const text = window.trim()
  if (!titleOnly && /^\d+$/.test(text)) {
    const byId = windows.filter((w) => Number(w.window_id) === Number(text))
    if (byId.length) return byId
  }
  return windows.filter((w) => titleMatches(windowTitle(w), text))
}

/** The record's title, from `title` or the older `window_title`. */
export const windowTitle = (w: { title?: unknown; window_title?: unknown }) =>
  typeof w.title === 'string' ? w.title : typeof w.window_title === 'string' ? w.window_title : ''
