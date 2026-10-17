import { defineExtension } from '@earendil-works/pi-durable'
import type {
  CommitPublication,
  ConversationId,
  Cursor,
  DocumentRecord,
  DocumentId,
  EntryId,
  JsonObject,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { docHash } from '../../cloud/protocol.ts'
import type { CloudMessage, MachineMessage, ReplicaDoc } from '../../cloud/protocol.ts'
import { cloudConfig } from './config.ts'

export const secrets = [
  { name: 'ULTIMATE_CLOUD_TOKEN', description: 'Bearer token for the cloud sync endpoint' },
]

type Batch = Extract<MachineMessage, { type: 'batch' }>
export const MAX_RETAINED_BYTES = 16 * 1024 * 1024
// Charge ID sets conservatively, including their bookkeeping rather than just their JSON digits.
const ID_BYTES = 64
export type SyncSocket = Pick<WebSocket, 'send' | 'close' | 'addEventListener'>
export type Connect = (url: string, token: string) => SyncSocket
// Node 26 accepts undici's options overload; DOM declarations only describe browser WebSockets.
const NodeWebSocket = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => SyncSocket
const connect: Connect = (url, token) =>
  new NodeWebSocket(url, { headers: { Authorization: `Bearer ${token}` } })

/** One outbound connection; injected transport keeps sync tests entirely in process. */
export function startSync(
  host: ExtensionHost,
  url: string,
  token: string,
  machine: string,
  dial = connect,
) {
  let stopped = false
  let retry = 1000
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let dispose: (() => void) | undefined
  let idle: (() => Promise<void>) | undefined
  let retainedBytes: (() => number) | undefined
  const open = () => {
    if (stopped) return
    let socket: SyncSocket
    try {
      socket = dial(url, token)
    } catch (error) {
      host.notice(`Cloud connection failed: ${String(error)}`)
      schedule()
      return
    }
    let closed = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let metadataTimer: ReturnType<typeof setInterval> | undefined
    let summariesDirty = true
    let ready = false
    let batch = 0
    const unacked = new Set<number>()
    const pending: Batch = { type: 'batch', batch: 0, conversations: [], entries: [], docs: [] }
    let pendingBytes = 0
    let bufferedBytes = 0
    const bufferedEntries: Batch['entries'] = []
    const changedDocs = new Set<DocumentId>()
    const changedConversations = new Set<ConversationId>()
    retainedBytes = () => pendingBytes + bufferedBytes
    const reserve = (bytes: number) => {
      if (closed) return false
      if (pendingBytes + bufferedBytes + bytes > MAX_RETAINED_BYTES) {
        host.notice('Cloud sync retained-data limit exceeded; reconnecting from the replica cursor')
        close()
        return false
      }
      return true
    }
    let capacity: (() => void) | undefined
    const entryHeads: Record<string, number> = {}
    const append = (values: unknown[], value: unknown) => {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      if (!reserve(bytes)) return
      values.push(value)
      pendingBytes += bytes
    }
    const entry = (value: Batch['entries'][number]) => {
      if (value.id <= (entryHeads[value.conversationId] ?? 0)) return
      entryHeads[value.conversationId] = value.id
      append(pending.entries, value)
    }
    let changesQueued = false
    let chain = Promise.resolve()
    idle = () => chain
    let lastSummaries = ''
    let lastSystem = ''
    const send = (message: MachineMessage) => {
      if (!closed) socket.send(JSON.stringify(message))
    }
    const fail = (error: unknown) => {
      host.notice(`Cloud sync failed: ${String(error)}`)
      close()
    }
    const enqueue = (work: () => Promise<void>) => {
      chain = chain
        .then(async () => {
          if (!closed) await work()
        })
        .catch(fail)
    }
    const flush = () => {
      clearTimeout(timer)
      timer = undefined
      if (closed) return
      while (
        unacked.size < 4 &&
        (pending.conversations.length || pending.entries.length || pending.docs.length)
      ) {
        const next: Batch = {
          type: 'batch',
          batch: ++batch,
          conversations: [],
          entries: [],
          docs: [],
        }
        let bytes = 0
        for (const key of ['conversations', 'entries', 'docs'] as const) {
          let count = 0
          while (count < pending[key].length && bytes < 1_000_000) {
            const value = pending[key][count++]
            const size = Buffer.byteLength(JSON.stringify(value))
            bytes += size
            pendingBytes -= size
            // Each array is homogeneous; the key selects the corresponding destination.
            ;(next[key] as unknown[]).push(value)
          }
          pending[key].splice(0, count)
        }
        unacked.add(next.batch)
        send(next)
      }
    }
    const queue = () => {
      if (closed) return
      if (pendingBytes >= 1_000_000) flush()
      else timer ??= setTimeout(flush, 250)
    }
    const waitForCapacity = async () => {
      flush()
      while (true) {
        if (closed || (unacked.size < 4 && pendingBytes === 0)) return
        await new Promise<void>((resolve) => {
          capacity = resolve
        })
        flush()
      }
    }
    const document = async (record: DocumentRecord, value: JsonObject | null) => {
      if (record.scope.kind !== 'conversation') return
      const doc: ReplicaDoc = {
        id: record.id,
        kind: record.kind,
        key: record.key,
        conversationId: record.scope.conversationId,
        value,
        hash: await docHash(value),
      }
      if (closed) return
      const index = pending.docs.findIndex((item) => item.id === doc.id)
      if (index < 0) append(pending.docs, doc)
      else {
        const delta =
          Buffer.byteLength(JSON.stringify(doc)) -
          Buffer.byteLength(JSON.stringify(pending.docs[index]))
        if (!reserve(delta)) return
        pending.docs[index] = doc
        pendingBytes += delta
      }
    }
    const metadata = () => {
      const system = host.system()
      const systemJson = JSON.stringify(system)
      if (summariesDirty) {
        summariesDirty = false
        const summaries = host.conversations()
        const summaryJson = JSON.stringify(summaries)
        if (summaryJson !== lastSummaries) {
          lastSummaries = summaryJson
          send({ type: 'summaries', value: summaries })
        }
      }
      if (systemJson !== lastSystem) {
        lastSystem = systemJson
        send({ type: 'system', value: system })
      }
    }
    const mark = <T extends number>(ids: Set<T>, id: T) => {
      if (!ids.has(id) && reserve(ID_BYTES)) {
        ids.add(id)
        bufferedBytes += ID_BYTES
      }
    }
    const buffer = (publication: CommitPublication) => {
      for (const change of publication.changes) {
        if (closed) return
        if (change.type === 'conversation') mark(changedConversations, change.value.id)
        else if (
          (change.type === 'document' || change.type === 'document.copy') &&
          change.record.scope.kind === 'conversation'
        )
          mark(changedDocs, change.record.id)
      }
      // Publications have no change order. Do not retain the publication or its document values.
      for (const value of publication.changes
        .filter((change) => change.type === 'entry')
        .map((change) => change.value)
        .toSorted((a, b) => a.id - b.id)) {
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (!reserve(bytes)) return
        bufferedEntries.push(value)
        bufferedBytes += bytes
      }
    }
    const drainChanges = async () => {
      while (bufferedEntries.length || changedConversations.size || changedDocs.size) {
        if (closed) return
        for (const value of bufferedEntries.splice(0, 256)) {
          if (closed) return
          bufferedBytes -= Buffer.byteLength(JSON.stringify(value))
          entry(value)
        }
        const conversationId = changedConversations.values().next().value
        if (conversationId !== undefined) {
          changedConversations.delete(conversationId)
          bufferedBytes -= ID_BYTES
          const record = await host
            .harness()
            .commit((tx) => tx.conversation(conversationId), context)
          if (record) append(pending.conversations, record)
        }
        const id = changedDocs.values().next().value
        if (id !== undefined) {
          changedDocs.delete(id)
          bufferedBytes -= ID_BYTES
          const stored = await host.document(id, 'current', context)
          if (stored) await document(stored.record, stored.value)
          else
            append(pending.docs, {
              id,
              kind: '',
              conversationId: 0,
              value: null,
              hash: await docHash(null),
            })
        }
        queue()
      }
      summariesDirty = true
    }
    const catchUp = async (cursor: Extract<CloudMessage, { type: 'cursor' }>) => {
      if (ready) throw new Error('Duplicate cloud cursor')
      unsubscribe = host.harness().subscribeCommits((publication) => {
        buffer(publication)
        if (ready && !closed && !changesQueued) {
          changesQueued = true
          enqueue(async () => {
            changesQueued = false
            await drainChanges()
          })
        }
      })
      Object.assign(entryHeads, cursor.entries)
      const harness = host.harness()
      const seen = new Set<number>()
      let conversationCursor: Cursor | undefined
      do {
        await waitForCapacity()
        if (closed) return
        // Only the small conversation-record page needs the commit line. History reads do not.
        const conversations = await harness.commit(
          (tx) => tx.scanConversations({}, 256, conversationCursor),
          context,
        )
        for (const record of conversations.items) append(pending.conversations, record)
        for (const record of conversations.items) {
          const conversation = await harness.conversation(record.id, context)
          if (!conversation) continue
          let entryCursor: Cursor | undefined
          do {
            await waitForCapacity()
            if (closed) return
            const page = await conversation.entries(
              { minEntryId: ((cursor.entries[record.id] ?? 0) + 1) as EntryId, order: 'ascending' },
              256,
              entryCursor,
              context,
            )
            for (const value of page.items) {
              if (pendingBytes >= 1_000_000) await waitForCapacity()
              if (closed) return
              if (value.conversationId === record.id) entry(value)
            }
            entryCursor = page.next
          } while (entryCursor)
          let docCursor: Cursor | undefined
          do {
            await waitForCapacity()
            if (closed) return
            const page = await host.scanDocuments(
              { scope: { kind: 'conversation', conversationId: record.id }, at: 'current' },
              256,
              docCursor,
              context,
            )
            for (const doc of page.items) {
              if (pendingBytes >= 1_000_000) await waitForCapacity()
              if (closed) return
              const stored = await host.document(doc.id, 'current', context)
              if (!stored) continue
              seen.add(doc.id)
              const hash = await docHash(stored.value)
              if (!changedDocs.has(doc.id) && hash !== cursor.docs[String(doc.id)])
                await document(doc, stored.value)
            }
            docCursor = page.next
          } while (docCursor)
        }
        conversationCursor = conversations.next
      } while (conversationCursor)
      // A retired incarnation is absent locally. Only its ID matters for deletion at the replica.
      for (const id of Object.keys(cursor.docs)) {
        if (!seen.has(Number(id))) {
          await waitForCapacity()
          if (closed) return
          append(pending.docs, {
            id: Number(id),
            kind: '',
            conversationId: 0,
            value: null,
            hash: await docHash(null),
          })
        }
      }
      await waitForCapacity()
      if (closed) return
      ready = true
      await drainChanges()
      queue()
    }
    const close = () => {
      if (closed) return
      closed = true
      unsubscribe?.()
      pending.conversations.length = 0
      pending.entries.length = 0
      pending.docs.length = 0
      bufferedEntries.length = 0
      changedDocs.clear()
      changedConversations.clear()
      pendingBytes = 0
      bufferedBytes = 0
      capacity?.()
      capacity = undefined
      clearTimeout(timer)
      clearInterval(metadataTimer)
      socket.close()
      if (!stopped) schedule()
    }
    dispose = close
    socket.addEventListener('open', () => {
      send({ type: 'hello', machine, build: host.build().id })
      metadata()
      metadataTimer = setInterval(metadata, 1000)
      enqueue(async () => send({ type: 'models', value: await host.modelsResponse() }))
    })
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as CloudMessage
        if (message.type === 'ack') {
          unacked.delete(message.batch)
          flush()
          capacity?.()
          capacity = undefined
        } else if (message.type === 'cursor')
          enqueue(async () => {
            await catchUp(message)
            retry = 1000
          })
        else if (message.type === 'outbox')
          enqueue(async () => {
            for (const item of message.items) {
              const conversation = await host
                .harness()
                .conversation(item.conversationId as ConversationId, context)
              if (!conversation) {
                host.notice(`Cloud outbox: unknown conversation ${item.conversationId}`)
                continue
              }
              const result = await conversation.submit(
                { type: 'input', content: item.text, whenBusy: item.whenBusy, requestId: item.id },
                context,
              )
              send({ type: 'delivered', id: item.id, submissionId: result.id })
            }
          })
      } catch (error) {
        fail(error)
      }
    })
    socket.addEventListener('close', close)
    socket.addEventListener('error', close)
  }
  const schedule = () => {
    reconnect = setTimeout(open, retry)
    retry = Math.min(30_000, retry * 2)
  }
  open()
  return Object.assign(
    () => {
      stopped = true
      clearTimeout(reconnect)
      dispose?.()
    },
    {
      idle: async () => {
        await idle?.()
      },
      retainedBytes: () => retainedBytes?.() ?? 0,
    },
  )
}

export default function cloud(host: ExtensionHost) {
  let stop: ReturnType<typeof startSync> | undefined
  host.onOpen(async () => {
    const config = await cloudConfig(host)
    if (config) stop = startSync(host, config.url, config.token, config.machine)
  })
  host.onClose(async () => {
    stop?.()
    await stop?.idle()
  })
  return defineExtension({ name: 'cloud' })
}
