/**
 * The decisions block agents end a question to the user with, read without a model:
 *
 *   Decisions:
 *   1. **Topic:** (a) first option; (b) second option.
 *   2. **Topic:** (a) …; (b) ….
 *   My picks: 1a 2b.
 *
 * Only the last run of numbered items carrying lettered options counts, so numbered lists earlier in a message (findings,
 * steps) are ignored. Picks come from a "my picks" phrase anywhere in the message, or from "(recommended)" on an option.
 */
export type Decision = {
  ref: string
  topic: string
  options: { key: string; label: string; detail?: string; recommended?: boolean }[]
}

/** Card text shows no markdown: inline code loses its backticks. */
const plain = (text: string) => text.replace(/`/g, '')

const ITEM = /^\s*(\d+)[.)]\s+(.*)$/
const LETTERED = /\(([a-z])\)\s*/g

/** Text without bold markers and with collapsed whitespace. */
const clean = (text: string) =>
  text
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()

function option(key: string, raw: string, picked: boolean): Decision['options'][number] {
  let text = clean(raw).replace(/[;,.]\s*$/, '')
  const recommended = picked || /\((recommended|my pick)\)/i.test(text)
  text = text.replace(/\s*\((recommended|my pick)\)/gi, '').trim()
  // A short lead before ': ', '; ', ' — ' or '. ' is the label; the rest explains it.
  const split = /^(.{3,70}?)(?::\s|;\s|\s[—–-]\s|\.\s)(.+)$/.exec(text)
  // Never inside inline code.
  const [label, detail] = (
    split && (split[1].split('`').length - 1) % 2 === 0 ? [split[1], split[2]] : [text]
  ).map(plain)
  return {
    key,
    label,
    ...(detail ? { detail } : {}),
    ...(recommended ? { recommended: true } : {}),
  }
}

/** The picks a message states: "my picks: 1a 2b", "(my picks are 1a, 2a, go)", "\"1b 2a\" are my picks". */
export function statedPicks(text: string) {
  const picks = new Map<string, string>()
  for (const match of text.matchAll(/[^\n]*\bpicks?\b[^\n]*/gi))
    for (const pick of match[0].matchAll(/\b(\d+)([a-z])\b/g)) picks.set(pick[1], pick[2])
  return picks
}

/** The last decisions block in `text`, or none when it has no numbered items with lettered options. */
export function parseDecisions(text: string): Decision[] {
  const picks = statedPicks(text)
  const decision = (ref: string, body: string): Decision | undefined => {
    const parts = body.split(LETTERED)
    // ['Topic: ', 'a', 'first; ', 'b', 'second.']
    if (parts.length < 3) return undefined
    const topic = plain(clean(parts[0]).replace(/[:\s]+$/, ''))
    // Letters run a, b, c…; a letter out of sequence is a mention inside the previous option's text.
    const options: [string, string][] = []
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const expected = String.fromCharCode(97 + options.length)
      if (parts[i] === expected) options.push([parts[i], parts[i + 1]])
      else if (options.length) options[options.length - 1][1] += `(${parts[i]}) ${parts[i + 1]}`
      else return undefined
    }
    return topic && options.length >= 2
      ? {
          ref,
          topic,
          options: options.map(([key, raw]) => option(key, raw, picks.get(ref) === key)),
        }
      : undefined
  }
  // Runs of numbered items; blank lines stay inside a run, any other line ends it, indented lines continue an item.
  const blocks: Decision[][] = []
  let block: { ref: string; body: string }[] = []
  const close = () => {
    const decisions = block.flatMap(({ ref, body }) => decision(ref, body) ?? [])
    if (decisions.length) blocks.push(decisions)
    block = []
  }
  for (const line of text.split('\n')) {
    const item = ITEM.exec(line)
    if (item) block.push({ ref: item[1], body: item[2] })
    else if (block.length && /^\s{2,}\S/.test(line))
      block[block.length - 1].body += ' ' + line.trim()
    else if (line.trim()) close()
  }
  close()
  return blocks.at(-1) ?? []
}
