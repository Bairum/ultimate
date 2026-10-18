import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

/** A transcript row: an entry, or only some content blocks of an assistant message. */
export interface ChatPart {
  entry: EntryRecord
  /** Indexes of the content blocks shown; the whole entry when absent. */
  blocks?: readonly number[]
}
/** A run of work folded into one row: the parts it hides and its steps, the tool calls and thoughts in it. */
export interface WorkRun {
  work: readonly ChatPart[]
  steps: number
}

const stepsOf = (blocks: AssistantMessage['content']) =>
  blocks.filter(
    (block) =>
      block.type === 'toolCall' ||
      (block.type === 'thinking' && (!!block.thinking || !!block.redacted)),
  ).length

/**
 * The rows of a conversation that reads as a chat. Each run of tool calls and thinking between inputs, messages and
 * answers folds into one `WorkRun`, without the calls `visible` keeps: those split a run and stay rows of their own.
 * Only responses that go on to use tools are work; an answer shows whole, its thinking included. System prompt changes
 * join the run they fall in, and a run without a step shows as it is.
 */
export function chatRows(
  entries: readonly EntryRecord[],
  visible: (call: ToolCall) => boolean,
): (ChatPart | WorkRun)[] {
  const rows: (ChatPart | WorkRun)[] = []
  let run: ChatPart[] = []
  let steps = 0
  const flush = () => {
    if (steps > 0) rows.push({ work: run, steps })
    else rows.push(...run)
    run = []
    steps = 0
  }
  const show = (part: ChatPart) => {
    flush()
    rows.push(part)
  }
  for (const entry of entries) {
    const message = entry.model?.[0]
    if (entry.kind === 'pi.system') {
      run.push({ entry })
      continue
    }
    if (entry.kind === 'pi.tool-result') {
      run.push({ entry })
      steps++
      continue
    }
    if (
      entry.kind !== 'pi.assistant' ||
      message?.role !== 'assistant' ||
      message.stopReason !== 'toolUse'
    ) {
      show({ entry })
      continue
    }
    const { content } = message
    const quiet = content.map((block) => block.type !== 'toolCall' || !visible(block))
    if (!quiet.includes(false)) {
      run.push({ entry })
      steps += stepsOf(content)
      continue
    }
    if (!quiet.includes(true)) {
      show({ entry })
      continue
    }
    for (let start = 0, end = 1; end <= content.length; end++) {
      if (end < content.length && quiet[end] === quiet[start]) continue
      const blocks = Array.from({ length: end - start }, (_, offset) => start + offset)
      if (quiet[start]) {
        run.push({ entry, blocks })
        steps += stepsOf(content.slice(start, end))
      } else show({ entry, blocks })
      start = end
    }
  }
  flush()
  return rows
}

/** The folded run where `entry` first shows, if it starts in one: revealing the entry opens it. */
export function runOf(rows: readonly (ChatPart | WorkRun)[], entry: number) {
  const first = rows.find((row) =>
    ('work' in row ? row.work : [row]).some((part) => part.entry.id === entry),
  )
  return first && 'work' in first ? first : undefined
}
