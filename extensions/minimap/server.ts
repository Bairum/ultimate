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

/** Per conversation, what earlier calls read; module state, so a reinstalled classifier starts over. */
const scans = new Map<number, Scan>()

/**
 * Marks of one conversation read so far: those up to entry `upTo`, of which the ones from `open` on belong to the turn
 * still open (its last answer may change), with that turn's entries to classify again with what follows.
 */
interface Scan {
  upTo: number
  marks: Mark[]
  open: EntryRecord[]
}

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

/** Commits made from conversation `id` after event `after`, each placed at the newest entry before it. */
async function commits(host: ExtensionHost, id: number, after: number, entries: readonly number[]) {
  const marks: Mark[] = []
  for (let since = after; ;) {
    const page = await host.eventLog.recent({
      events: [Committed],
      since,
      order: 'ascending',
      limit: PAGE,
    })
    for (const event of page) {
      if (event.data.conversation !== id) continue
      // Entry and event ids share one sequence: the bash call that committed comes just before.
      const entry = entries.findLast((candidate) => candidate < event.id)
      if (entry !== undefined)
        marks.push({
          entry,
          kind: 'commit',
          text: line(`${event.data.sha.slice(0, 7)} ${event.data.subject}`),
          at: Date.parse(event.at),
        })
    }
    if (page.length < PAGE) return marks
    since = page.at(-1)!.id
  }
}

export const actions = {
  /** `{ conversationId }`: every mark of its own history, oldest first; repeated calls read only what is new. */
  marks: implementAction(MarksAction, async (args, { host }) => {
    const id =
      args && typeof args === 'object' && !Array.isArray(args) ? args.conversationId : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id))
      throw new Error('Expected { conversationId }')
    const previous = scans.get(id) ?? { upTo: 0, marks: [], open: [] }
    const fresh = await entriesAfter(host, id as ConversationId, previous.upTo)
    if (!fresh.length && scans.has(id)) return previous.marks
    const open = previous.open[0]?.id
    const kept =
      open === undefined ? previous.marks : previous.marks.filter((mark) => mark.entry < open)
    const turn = [...previous.open, ...fresh]
    const ids = turn.map((entry) => entry.id)
    const marks = [
      ...kept,
      ...[
        ...classify(turn),
        ...(await commits(host, id, ids[0] ? ids[0] - 1 : previous.upTo, ids)),
      ].toSorted((a, b) => a.entry - b.entry),
    ]
    const start = turn.findLastIndex(isInput)
    const scan = {
      upTo: turn.at(-1)?.id ?? previous.upTo,
      marks,
      open: start === -1 ? turn : turn.slice(start),
    }
    scans.set(id, scan)
    return marks
  }),
}

export default function minimapExtension(_host: ExtensionHost) {
  return defineExtension({ name: 'minimap' })
}
