import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  AgentDoc,
  defineDoc,
  defineExtension,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  UsageDoc,
} from '@earendil-works/pi-durable'
import type {
  AgentState,
  CommitPublication,
  ConversationId,
  Cursor,
  EntryRecord,
  LiveState,
  Tx,
  UsageState,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { active, applyAgent, applyEntry, applyLive, applyUsage, newFeed } from './feed.ts'
import type { Feed, Place } from './feed.ts'
import type { CanvasState } from './types.ts'

export const Canvas = defineDoc<CanvasState>({
  kind: 'ultimate.canvas',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {} }),
  // Streaming rewrites a few fields several times a second; store a complete base now and then.
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 200,
})
export const docs = [Canvas]

/** Milliseconds between commits of the document: at most about four a second. */
const INTERVAL = 250
/** Rows kept, the most recently active first. */
const AGENTS = 150
/** Entries read per conversation, newest first, to rebuild its row. */
const SCAN = 48
/** Conversations rebuilt per transaction. */
const BATCH = 16
const ARCHIVED = 'ext.conversations.archived'

const archivedIds = (value: JsonValue | undefined) =>
  new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'number') : [])

/** Rebuild a row from the newest stored entries and the live state. */
async function rebuild(tx: Tx, id: ConversationId, place: Place) {
  const entries: EntryRecord[] = []
  let cursor: Cursor | undefined
  let done = false
  do {
    const page = await tx.scanEntries({ conversationId: id }, 16, cursor)
    for (const entry of page.items) {
      // A fork's scan continues into the history it inherited.
      done = entry.conversationId !== id || entries.length === SCAN
      if (done) break
      entries.push(entry)
    }
    cursor = page.next
  } while (!done && cursor !== undefined)
  const feed = newFeed()
  for (const entry of entries.toReversed())
    applyEntry(feed, entry, entry.model?.[0]?.timestamp ?? feed.agent.updatedAt, () => place)
  const live = await tx.doc(LiveDoc, id)
  applyLive(feed, live, live.generation ? Date.now() : feed.agent.updatedAt)
  applyUsage(feed, await tx.doc(UsageDoc, id))
  applyAgent(feed, await tx.doc(AgentDoc, id))
  return feed
}

/** Keeps `ultimate.canvas` on the root conversation: a small live activity row per agent. */
export default (host: ExtensionHost) => {
  const feeds = new Map<ConversationId, Feed>()
  /** Every known conversation with its owner or fork source, so an archived one hides its subagents too. */
  const parents = new Map<ConversationId, ConversationId | undefined>()
  let archived = new Set<number>()
  let archiveChanges = 0
  const dirty = new Set<ConversationId>()
  /** The next write also removes stored rows that have no feed. */
  let sweep = false
  let ready = false
  let closed = true
  let stop: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  let work = Promise.resolve()

  const hidden = (id: ConversationId, set = archived) => {
    for (let at: ConversationId | undefined = id; at !== undefined; at = parents.get(at))
      if (set.has(at)) return true
    return false
  }
  const place = (id: ConversationId): Place => ({
    cwd: host.conversations().find((summary) => summary.id === id)?.cwd ?? host.projectRoot,
    home: host.userHome,
  })
  const run = (task: () => Promise<void>) => {
    work = work.then(task).catch((error: unknown) => {
      if (!closed) host.notice(`Canvas: ${String(error)}`)
    })
    return work
  }
  const write = async () => {
    const ids = [...dirty]
    dirty.clear()
    const full = sweep
    sweep = false
    last = Date.now()
    if (!ids.length && !full) return
    await host.harness().commit(async (tx) => {
      const { agents } = await tx.doc(Canvas, ROOT_CONVERSATION_ID)
      if (full)
        for (const key of Object.keys(agents))
          if (!feeds.has(Number(key) as ConversationId)) delete agents[key]
      for (const id of ids) {
        const key = String(id)
        const agent = feeds.get(id)?.agent
        if (!agent || !active(agent)) {
          if (Object.hasOwn(agents, key)) delete agents[key]
          continue
        }
        const row = agents[key] as Record<string, unknown> | undefined
        if (!row) {
          agents[key] = structuredClone(agent)
          continue
        }
        // Field by field, so a streaming text sends only itself to every tab.
        for (const field of Object.keys(row)) if (!(field in agent)) delete row[field]
        for (const [field, value] of Object.entries(agent))
          if (JSON.stringify(row[field]) !== JSON.stringify(value))
            row[field] = structuredClone(value)
      }
    }, context)
  }
  const schedule = () => {
    if (!ready || closed || timer) return
    timer = setTimeout(
      () => {
        timer = undefined
        void run(write)
      },
      Math.max(0, last + INTERVAL - Date.now()),
    )
  }
  const touch = (id: ConversationId) => {
    dirty.add(id)
    schedule()
  }
  const evict = () => {
    if (feeds.size <= AGENTS) return
    const ranked = [...feeds].toSorted(([, a], [, b]) => b.agent.updatedAt - a.agent.updatedAt)
    for (const [id] of ranked.slice(AGENTS)) {
      feeds.delete(id)
      touch(id)
    }
  }
  const update = (id: ConversationId, apply: (feed: Feed) => boolean) => {
    if (hidden(id)) return
    const feed = feeds.get(id) ?? newFeed()
    if (!apply(feed)) return
    // Kept before it has activity too: the model and spend arrive before the first answer does.
    feeds.set(id, feed)
    if (active(feed.agent)) touch(id)
  }
  /** Rebuild rows a batch per transaction, adopting each inside it: later commits apply on top. */
  const hydrate = async (ids: ConversationId[]) => {
    for (let start = 0; start < ids.length; start += BATCH) {
      if (closed) return
      const batch = ids.slice(start, start + BATCH)
      const places = new Map<ConversationId, Place>()
      for (const id of batch)
        places.set(id, {
          cwd: (await host.harness().snapshot(AgentDoc, id, context))?.cwd ?? host.projectRoot,
          home: host.userHome,
        })
      await host.harness().commit(async (tx) => {
        const built: [ConversationId, Feed][] = []
        for (const id of batch) built.push([id, await rebuild(tx, id, places.get(id)!)])
        for (const [id, feed] of built) {
          if (hidden(id)) continue
          if (active(feed.agent)) feeds.set(id, feed)
          else feeds.delete(id)
          touch(id)
        }
      }, context)
    }
    evict()
  }
  const archive = (next: Set<number>) => {
    if (next.size === archived.size && [...next].every((id) => archived.has(id))) return
    archiveChanges++
    const before = archived
    archived = next
    for (const id of feeds.keys())
      if (hidden(id)) {
        feeds.delete(id)
        touch(id)
      }
    const shown = [...parents.keys()].filter((id) => hidden(id, before) && !hidden(id))
    if (shown.length) void run(() => hydrate(shown))
  }
  const listen = (publication: CommitPublication) => {
    if (closed) return
    try {
      const now = Date.now()
      const entries: EntryRecord[] = []
      const lives: [ConversationId, LiveState][] = []
      const usages: [ConversationId, UsageState][] = []
      const models: [ConversationId, AgentState][] = []
      for (const change of publication.changes) {
        if (change.type === 'conversation')
          parents.set(
            change.value.id,
            change.value.owner?.conversationId ?? change.value.parent?.conversationId,
          )
        else if (change.type === 'entry') entries.push(change.value)
        else if (change.type === 'document' && change.conversationId !== undefined && change.value)
          if (change.record.kind === LiveDoc.definition.kind)
            lives.push([change.conversationId, change.value])
          else if (change.record.kind === UsageDoc.definition.kind)
            usages.push([change.conversationId, change.value as UsageState])
          else if (change.record.kind === AgentDoc.definition.kind)
            models.push([change.conversationId, change.value])
          else if (
            change.record.kind === 'ultimate.ui' &&
            change.conversationId === ROOT_CONVERSATION_ID
          )
            archive(archivedIds(change.value[ARCHIVED]))
      }
      // Calls before their results, and both before the round's live statuses.
      for (const entry of entries.toSorted((a, b) => a.id - b.id))
        update(entry.conversationId, (feed) =>
          applyEntry(feed, entry, now, () => place(entry.conversationId)),
        )
      for (const [id, live] of lives) update(id, (feed) => applyLive(feed, live, now))
      for (const [id, usage] of usages) update(id, (feed) => applyUsage(feed, usage))
      for (const [id, agent] of models) update(id, (feed) => applyAgent(feed, agent))
      evict()
    } catch (error) {
      host.notice(`Canvas: ${String(error)}`)
    }
  }

  /** Rank conversations by their newest own entry, then rebuild the most recent. */
  const rank = async () => {
    const latest = await host.harness().commit(async (tx) => {
      const found: [ConversationId, number][] = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const record of page.items) {
          parents.set(record.id, record.owner?.conversationId ?? record.parent?.conversationId)
          const [entry] = (await tx.scanEntries({ conversationId: record.id }, 1)).items
          if (entry?.conversationId === record.id) found.push([record.id, entry.id])
        }
        cursor = page.next
      } while (cursor !== undefined)
      return found
    }, context)
    await hydrate(
      latest
        .filter(([id]) => !hidden(id))
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, AGENTS)
        .map(([id]) => id),
    )
  }

  host.onOpen(async () => {
    closed = false
    ready = false
    feeds.clear()
    parents.clear()
    dirty.clear()
    stop = host.harness().subscribeCommits(listen)
    const changes = archiveChanges
    const ui = await host.uiState(context)
    if (changes === archiveChanges) archived = archivedIds(ui[ARCHIVED])
    await run(async () => {
      try {
        await rank()
      } finally {
        // Live changes keep flowing even if the rebuild failed; the first write drops stale rows.
        ready = true
        sweep = true
      }
      await write()
    })
  })
  host.onClose(async () => {
    closed = true
    ready = false
    stop?.()
    clearTimeout(timer)
    timer = undefined
    await work
  })
  return defineExtension({ name: 'canvas' })
}
