import type { Message } from '@earendil-works/pi-ai'

type ToolResult = Extract<Message, { role: 'toolResult' }>
type Block = ToolResult['content'][number]

const KEEP_IMAGES = 3
const KEEP_TREES = 2
const BATCH = 4
const opening = '<untrusted_screen_content>\n'

/** Oldest entries to elide: whole batches only, so the set changes once per BATCH new items (prompt-cache friendly). */
export const elidedCount = (total: number, keep: number) =>
  Math.floor(Math.max(0, total - keep) / BATCH) * BATCH

/** The observation metadata line of a text block, or undefined for any other text (step summaries, anchors). */
function observation(block: Block) {
  if (block.type !== 'text' || !block.text.startsWith(`${opening}{`)) return undefined
  try {
    const meta = JSON.parse(block.text.slice(opening.length).split('\n', 1)[0]) as {
      app?: unknown
      snapshot?: unknown
      capture?: { id?: unknown }
    }
    return typeof meta.app === 'string' && typeof meta.snapshot === 'string' ? meta : undefined
  } catch {
    // Not metadata JSON: leave the block alone.
    return undefined
  }
}

/**
 * Replace old screenshots and AX trees of computer_observe/computer_act results with short stubs. A pure function of
 * the messages; stored history is untouched.
 */
export function elideObservations(messages: readonly Message[]): Message[] {
  const results = messages.filter(
    (m): m is ToolResult =>
      m.role === 'toolResult' &&
      (m.toolName === 'computer_observe' || m.toolName === 'computer_act'),
  )
  const images = results.flatMap((m) => m.content.filter((b) => b.type === 'image'))
  const trees = results.flatMap((m) => m.content.filter((b) => observation(b)))
  const dropImages = new Set<Block>(images.slice(0, elidedCount(images.length, KEEP_IMAGES)))
  const dropTrees = new Set<Block>(trees.slice(0, elidedCount(trees.length, KEEP_TREES)))
  if (!dropImages.size && !dropTrees.size) return messages as Message[]
  return messages.map((message) => {
    if (message.role !== 'toolResult' || !results.includes(message)) return message
    if (!message.content.some((b) => dropImages.has(b) || dropTrees.has(b))) return message
    const capture = message.content.map(observation).find(Boolean)?.capture?.id
    return {
      ...message,
      content: message.content.map((block): Block => {
        if (dropImages.has(block))
          return {
            type: 'text',
            text: `[screenshot elided: capture ${typeof capture === 'string' ? capture : 'unknown'}; a newer capture supersedes it]`,
          }
        const meta = dropTrees.has(block) ? observation(block) : undefined
        if (meta)
          return {
            type: 'text',
            text: `[AX tree of ${String(meta.app)} snapshot ${String(meta.snapshot)} elided; a newer observation supersedes it]`,
          }
        return block
      }),
    }
  })
}
