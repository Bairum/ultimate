import type { EntryRecord } from '@earendil-works/pi-durable'
import { isInput } from '../../lib/entries.ts'
import type { Mark, MarkKind } from './refs.ts'

const LABEL = 120

/** One line of `text`: whitespace collapsed, Markdown emphasis dropped, cut at a word near `LABEL` characters. */
export function line(text: string) {
  const flat = text
    .replaceAll(/[*_`#>]+/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
  if (flat.length <= LABEL) return flat
  const cut = flat.slice(0, LABEL)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), LABEL - 20))}…`
}

const textOf = (entry: EntryRecord) =>
  (entry.model ?? [])
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    )
    .join(' ')

const field = (data: unknown, key: string) =>
  data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)[key]
    : undefined
const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** Tool calls that mark a milestone, by tool name: the kind, and the label from its arguments. */
function callMark(name: string, args: Record<string, unknown>): [MarkKind, string] | undefined {
  if (name === 'branch') return ['branch', str(args.title) || str(args.prompt)]
  if (name === 'subagent' && args.action === 'start')
    return ['subagent', `${str(args.agent)}: ${str(args.task)}`]
  if (name === 'instance' && args.action === 'start') return ['preview', 'Preview started']
  if (name === 'screenshot') return ['screenshot', str(args.url) || 'Screenshot']
  if (name === 'workspace' && args.action === 'submit') return ['submit', 'Submitted to the lander']
  if (name === 'restart') return ['restart', 'Restarted the host']
  return undefined
}

/**
 * The marks entry `entry` makes, oldest first. `answer` is true for the last assistant message before the next input,
 * which the caller decides by looking ahead.
 */
export function marksOf(entry: EntryRecord, answer: boolean): Mark[] {
  const mark = (kind: MarkKind, text: string): Mark => ({
    entry: entry.id,
    kind,
    text: line(text),
    at: (entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp,
  })
  const data = entry.data
  switch (entry.kind) {
    case 'pi.user':
      return [mark('user', textOf(entry))]
    case 'board.message':
    case 'board.reply': {
      const from = field(data, 'from')
      const text = str(field(data, 'text'))
      return [mark(from === 'user' ? 'user' : 'message', text)]
    }
    case 'subagents.instruction':
      return [mark('message', str(field(data, 'body')))]
    case 'subagents.report':
      return [
        mark(
          field(data, 'failed') === true ? 'failed' : 'report',
          `${str(field(data, 'agent'))}: ${str(field(data, 'body'))}`,
        ),
      ]
    case 'workspaces.lander-report': {
      const outcome = field(data, 'outcome')
      const landed = field(outcome, 'outcome') === 'landed'
      const sha = str(field(outcome, 'sha')).slice(0, 7)
      return [
        mark(
          landed ? 'landed' : 'failed',
          landed ? `Landed ${sha}` : `Landing failed: ${str(field(outcome, 'reason'))}`,
        ),
      ]
    }
    case 'pi.compaction':
      return [mark('compaction', 'Context compacted')]
    case 'pi.assistant': {
      const marks: Mark[] = []
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') return marks
      for (const block of message.content)
        if (block.type === 'toolCall') {
          const found = callMark(block.name, block.arguments)
          if (found) marks.push(mark(...found))
        }
      const text = textOf(entry)
      if (answer && text.trim()) marks.push(mark('answer', text))
      return marks
    }
    default:
      if (isInput(entry) && entry.model?.[0]?.role === 'user') return [mark('user', textOf(entry))]
      return []
  }
}

/** Every mark of `entries` (oldest first): an assistant message is an answer when no other one follows before the next input. */
export function classify(entries: readonly EntryRecord[]): Mark[] {
  // Walk back once: the first assistant message seen after an input (or the end) is its turn's answer.
  const answers = new Set<EntryRecord>()
  let seen = false
  for (const entry of entries.toReversed()) {
    if (entry.kind === 'pi.assistant' && !seen) answers.add(entry)
    if (entry.kind === 'pi.assistant') seen = true
    if (isInput(entry)) seen = false
  }
  return entries.flatMap((entry) => marksOf(entry, answers.has(entry)))
}
