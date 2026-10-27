import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { isInput } from '../../lib/entries.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Committed } from '../coding-tools/api.ts'
import { classify, line } from './marks.ts'
import { MarksAction } from './refs.ts'
import type { Mark } from './refs.ts'

const PAGE = 512

/**
 * What earlier calls read of one conversation: its entries up to `upTo`, whose marks from the open turn on (`open`,
 * still classified again with what follows: its last answer may change) are not final; the assistant entries that
 * may anchor a commit; and its commits up to event `events`.
 */
interface Scan {
  upTo: number
  marks: Mark[]
  open: EntryRecord[]
  anchors: number[]
  events: number
  commits: Mark[]
}

/** Per conversation; module state, so a reinstalled classifier starts over. */
const scans = new Map<number, Scan>()

/** The conversation's own entries after `after`, oldest first; inherited fork history is the source's. */
async function entriesAfter(host: ExtensionHost, id: ConversationId, after: number) {
  const conversation = await host.harness().conversation(id, context)
  if (!conversation) throw new Error(`Unknown conversation #${id}`)
  const found: EntryRecord[] = []
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries(
      { order: 'ascending', minEntryId: (after + 1) as EntryId },
      PAGE,
      cursor,
      context,
    )
    found.push(...page.items.filter((entry) => entry.conversationId === id))
    cursor = page.next
  } while (cursor !== undefined)
  return found
}

/**
 * Commits made from conversation `id` after event `after`. Entry and event ids share one sequence, so the bash call
 * that committed is in the newest assistant entry before the event: the row the transcript shows for it.
 */
async function commitsAfter(host: ExtensionHost, id: number, after: number, anchors: number[]) {
  const marks: Mark[] = []
  let last = after
  for (;;) {
    const page = await host.eventLog.recent({
      events: [Committed],
      since: last,
      order: 'ascending',
      limit: PAGE,
    })
    for (const event of page) {
      const entry = anchors.findLast((candidate) => candidate < event.id)
      if (event.data.conversation === id && entry !== undefined)
        marks.push({
          entry,
          kind: 'commit',
          text: line(`${event.data.sha.slice(0, 7)} ${event.data.subject}`),
          at: Date.parse(event.at),
        })
    }
    if (page.length) last = page.at(-1)!.id
    if (page.length < PAGE) return { marks, last }
  }
}

export const actions = {
  /** `{ conversationId }`: every mark of its own history, oldest first; repeated calls read only what is new. */
  marks: implementAction(MarksAction, async (args, { host }) => {
    const id =
      args && typeof args === 'object' && !Array.isArray(args) ? args.conversationId : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id))
      throw new Error('Expected { conversationId }')
    const previous = scans.get(id) ?? {
      upTo: 0,
      marks: [],
      open: [],
      anchors: [],
      events: 0,
      commits: [],
    }
    const fresh = await entriesAfter(host, id as ConversationId, previous.upTo)
    const turn = [...previous.open, ...fresh]
    const open = previous.open[0]?.id
    const marks = [
      ...(open === undefined ? previous.marks : previous.marks.filter((mark) => mark.entry < open)),
      ...classify(turn),
    ]
    const anchors = [
      ...previous.anchors,
      ...fresh.filter((entry) => entry.kind === 'pi.assistant').map((entry) => entry.id),
    ]
    const found = await commitsAfter(host, id, previous.events, anchors)
    const start = turn.findLastIndex(isInput)
    const scan: Scan = {
      upTo: turn.at(-1)?.id ?? previous.upTo,
      marks,
      open: start === -1 ? turn : turn.slice(start),
      anchors,
      events: found.last,
      commits: [...previous.commits, ...found.marks],
    }
    scans.set(id, scan)
    return [...scan.marks, ...scan.commits].toSorted((a, b) => a.entry - b.entry)
  }),
}

export default function minimapExtension(_host: ExtensionHost) {
  return defineExtension({ name: 'minimap' })
}
