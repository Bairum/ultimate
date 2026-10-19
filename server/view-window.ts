import type { Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import type { StreamedView } from '../shared/protocol.ts'

/** Non-head entries a conversation stream starts with; older ones are paged in through `/history`. */
export const VIEW_WINDOW = 150

/**
 * The streamed part of `view`: its head marker, if any, and the newest `size` other entries. `trimmed` counts the
 * entries left out, and `older` names the oldest kept entry, the `before` cursor for the rest.
 */
export function windowView(
  view: ConversationView,
  size = VIEW_WINDOW,
): { view: StreamedView; trimmed: number } {
  const head = view.entries[0]?.head === undefined ? 0 : 1
  const trimmed = Math.max(0, view.entries.length - head - size)
  if (trimmed === 0) return { view, trimmed }
  const kept = view.entries.slice(head + trimmed)
  return {
    view: { ...view, entries: [...view.entries.slice(0, head), ...kept], older: kept[0].id },
    trimmed,
  }
}

/**
 * Pi's view ops for a window missing `trimmed` entries: appends move down by `trimmed`, documents pass through.
 * `undefined` when the batch replaces the view or places a head marker; send a fresh `windowView` then.
 */
export function windowOps(ops: readonly Op[], trimmed: number): readonly Op[] | undefined {
  if (trimmed === 0) return ops
  const rebased: Op[] = []
  for (const op of ops) {
    if (op[0] === 'r') return undefined
    if (op[1][0] !== 'entries') {
      rebased.push(op)
      continue
    }
    if (op[0] !== 'p' || op[1].length !== 1 || op[3] !== 0 || op[2] === 0) return undefined
    rebased.push(['p', op[1], op[2] - trimmed, 0, op[4]])
  }
  return rebased
}
