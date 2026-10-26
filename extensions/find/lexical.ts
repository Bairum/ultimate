/**
 * The lexical prior: keywords from the query, per-file keyword counts from one `rg` pass, IDF weights, and the
 * whole-line windows and keyword-dense sketches the judge reads.
 */
import type { FileEntry, MatchedLine } from './files.ts'

const STOPWORDS = new Set(
  (
    'the a an or and to is are be when where how that this of in on at for with by its it as from into like gets get ' +
    'up which what does do code file files over all user using then than there their they them you your we our has ' +
    'have had was were been being will would should can could not but if so such via per any some each every also ' +
    'just only more most other out off about after before between through during without within one two new used ' +
    'use make makes made run runs way thing things something actually really still yet'
  ).split(' '),
)

/** Cheap stem so a substring match covers inflections: merged, merges → merg; spawning → spawn. */
function stem(token: string) {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4)
      return token.slice(0, -suffix.length)
  }
  return token
}

/** Lowercased query tokens minus stopwords, short tokens and numbers, stemmed; then the caller's keywords. */
export function keywords(query: string, extra: readonly string[] = []) {
  const out: string[] = []
  for (const token of query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (token.length < 3 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue
    const stemmed = stem(token)
    if (!out.includes(stemmed)) out.push(stemmed)
  }
  for (const raw of extra) {
    const keyword = raw.trim().toLowerCase()
    if (keyword && !out.includes(keyword)) out.push(keyword)
  }
  return out
}

export function count(haystack: string, needle: string) {
  let found = 0
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    found++
  return found
}

/** Per-file keyword counts over matched lines, aligned with `words`. */
export function index(words: readonly string[], lines: readonly MatchedLine[]) {
  const counts = new Map<string, number[]>()
  for (const { rel, text } of lines) {
    let row = counts.get(rel)
    if (!row) counts.set(rel, (row = words.map(() => 0)))
    const lower = text.toLowerCase()
    words.forEach((word, k) => (row[k] += count(lower, word)))
  }
  return counts
}

/** Inverse document frequency per keyword, clamped to [0.5, 6] so one rare hit cannot outrank a real implementation. */
export function idf(words: readonly string[], counts: Map<string, number[]>, files: number) {
  return words.map((_, k) => {
    let df = 0
    for (const row of counts.values()) if (row[k] > 0) df++
    return Math.min(6, Math.max(0.5, Math.log((files + 1) / (df + 1))))
  })
}

/** Σ idf · (log(1 + count) + 2 when the keyword is in the path). */
export function fileScore(
  rel: string,
  row: readonly number[] | undefined,
  words: readonly string[],
  weights: readonly number[],
) {
  const lower = rel.toLowerCase()
  let score = 0
  words.forEach((word, k) => {
    score += weights[k] * ((lower.includes(word) ? 2 : 0) + Math.log1p(row?.[k] ?? 0))
  })
  return score
}

/** Files by lexical score, strongest first, then by path. */
export function rank(
  entries: readonly FileEntry[],
  words: readonly string[],
  counts: Map<string, number[]>,
  weights: readonly number[],
) {
  return entries
    .map((entry) => ({ entry, lex: fileScore(entry.rel, counts.get(entry.rel), words, weights) }))
    .toSorted((a, b) => b.lex - a.lex || (a.entry.rel < b.entry.rel ? -1 : 1))
}

/** A judged or matched line range with a one-line preview; `p` is the judge's probability when it has one. */
export type Range = { start: number; end: number; p?: number; snippet: string }

/** The matched lines of one file as up to `limit` ranges: lines within 3 of each other merge, densest first. */
export function lexicalRanges(
  lines: readonly MatchedLine[],
  words: readonly string[],
  weights: readonly number[],
  limit = 3,
) {
  const sorted = lines.toSorted((a, b) => a.line - b.line)
  const groups: { start: number; end: number; weight: number; best: number; snippet: string }[] = []
  for (const { line, text } of sorted) {
    const weight = lineWeight(text.toLowerCase(), words, weights)
    const last = groups.at(-1)
    if (last && line <= last.end + 3) {
      last.end = line
      last.weight += weight
      if (weight > last.best) Object.assign(last, { best: weight, snippet: text })
    } else groups.push({ start: line, end: line, weight, best: weight, snippet: text })
  }
  return groups
    .toSorted((a, b) => b.weight - a.weight || a.start - b.start)
    .slice(0, limit)
    .map(({ start, end, snippet }): Range => ({ start, end, snippet: preview(snippet) }))
}

export const preview = (line: string) => Array.from(line.trim()).slice(0, 100).join('')

/** Σ idf of the keywords a lowercased line contains. */
const lineWeight = (lower: string, words: readonly string[], weights: readonly number[]) =>
  words.reduce((sum, word, k) => sum + (lower.includes(word) ? weights[k] : 0), 0)

/** The preview of the passage line with the most keyword weight; the first non-blank line on a tie. */
export function densest(text: string, words: readonly string[], weights: readonly number[]) {
  let best = ''
  let score = -1
  for (const line of splitLines(text)) {
    if (!line.trim()) continue
    const weight = lineWeight(line.toLowerCase(), words, weights)
    if (weight > score) [best, score] = [line, weight]
  }
  return preview(best)
}

/** A run of whole lines tagged `L<n>| `, 1-based inclusive, with its lexical score. */
export type Passage = { start: number; end: number; text: string; score: number }

const bytes = (text: string) => Buffer.byteLength(text)

/** The longest prefix of `text` within `limit` UTF-8 bytes. */
function clip(text: string, limit: number) {
  if (bytes(text) <= limit) return text
  let used = 0
  let out = ''
  for (const char of text) {
    used += bytes(char)
    if (used > limit) break
    out += char
  }
  return out
}

export function splitLines(text: string) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Contiguous whole-line windows of at most `limit` bytes, tags included; an oversized line is clipped. */
export function windows(
  text: string,
  limit: number,
  words: readonly string[],
  weights: readonly number[],
) {
  const source = splitLines(text)
  const passages: Passage[] = []
  for (let start = 0; start < source.length;) {
    let end = start
    let content = ''
    let used = 0
    while (end < source.length) {
      const prefix = `L${end + 1}| `
      const overhead = prefix.length + 1
      if (end > start && used + bytes(source[end]) + overhead > limit) break
      const piece = `${prefix}${clip(source[end], Math.max(0, limit - used - overhead))}\n`
      content += piece
      used += bytes(piece)
      end++
      if (used >= limit) break
    }
    const lower = content.toLowerCase()
    const score = words.reduce(
      (sum, word, k) => sum + weights[k] * Math.log1p(count(lower, word)),
      0,
    )
    passages.push({ start: start + 1, end, text: content, score })
    start = end
  }
  return passages
}

/** The `limit` lexically best windows in file order; with no keyword anywhere, windows spread evenly. */
export function selectWindows(passages: Passage[], limit: number) {
  if (passages.length <= limit) return passages
  if (passages.every((passage) => passage.score === 0)) {
    const step = Math.max(limit - 1, 1)
    const keep = new Set(
      Array.from({ length: limit }, (_, k) => Math.floor((k * (passages.length - 1)) / step)),
    )
    return passages.filter((_, at) => keep.has(at))
  }
  return [...passages]
    .toSorted((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, limit)
    .toSorted((a, b) => a.start - b.start)
}

/** Passage text without its `L<n>| ` tags. */
export function plain(passage: Passage) {
  return splitLines(passage.text)
    .map((line, at) => {
      const prefix = `L${passage.start + at}| `
      return line.startsWith(prefix) ? line.slice(prefix.length) : line
    })
    .join('\n')
}

/** The passage's most keyword-dense verbatim lines within `budget` bytes, as `<line>: text` in file order. */
export function sketch(
  passage: Passage,
  words: readonly string[],
  weights: readonly number[],
  budget: number,
) {
  const lines = splitLines(plain(passage))
  const ranked = lines
    .map((line, at) => {
      const score = lineWeight(line.toLowerCase(), words, weights) + (line.includes('(') ? 0.1 : 0)
      return { at, score }
    })
    .filter(({ at }) => lines[at].trim())
    .toSorted((a, b) => b.score - a.score || a.at - b.at)
  const chosen: { at: number; text: string }[] = []
  let used = 0
  for (const { at } of ranked) {
    const available = budget - used - 12
    if (available < 24) break
    const text = `${passage.start + at}: ${clip(lines[at].trim(), Math.min(available, 180))}`
    used += bytes(text) + 1
    chosen.push({ at, text })
  }
  return chosen
    .toSorted((a, b) => a.at - b.at)
    .map((line) => line.text)
    .join('\n')
}

/** Union of ranges at or above `threshold`, keeping each merged span's best probability; strongest first. */
export function mergeRanges(ranges: readonly Range[], threshold: number) {
  const merged: Range[] = []
  for (const range of ranges
    .filter((candidate) => (candidate.p ?? 0) >= threshold)
    .toSorted((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1)
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
      if ((range.p ?? 0) > (last.p ?? 0))
        Object.assign(last, { p: range.p, snippet: range.snippet })
    } else merged.push({ ...range })
  }
  return merged.toSorted((a, b) => (b.p ?? 0) - (a.p ?? 0) || a.start - b.start)
}
