import { hostname } from 'node:os'
import { defineExtension } from '@earendil-works/pi-durable'
import type {
  CommitPublication,
  ConversationId,
  Cursor,
  DocumentRecord,
  EntryId,
  JsonObject,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { docHash } from '../../cloud/protocol.ts'
import type { CloudMessage, MachineMessage, ReplicaDoc } from '../../cloud/protocol.ts'

type Batch = Extract<MachineMessage, { type: 'batch' }>
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
    let capacity: (() => void) | undefined
    const entryHeads: Record<string, number> = {}
    const append = (values: unknown[], value: unknown) => {
      values.push(value)
      pendingBytes += Buffer.byteLength(JSON.stringify(value))
    }
    const entry = (value: Batch['entries'][number]) => {
      if (value.id <= (entryHeads[value.conversationId] ?? 0)) return
      entryHeads[value.conversationId] = value.id
      append(pending.entries, value)
    }
    let buffered: CommitPublication[] = []
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
      const index = pending.docs.findIndex((item) => item.id === doc.id)
      if (index < 0) append(pending.docs, doc)
      else {
        pendingBytes -= Buffer.byteLength(JSON.stringify(pending.docs[index]))
        pending.docs[index] = doc
        pendingBytes += Buffer.byteLength(JSON.stringify(doc))
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
    const live = async (publication: CommitPublication) => {
      for (const change of publication.changes) {
        if (change.type === 'conversation') append(pending.conversations, change.value)
        else if (
          (change.type === 'document' || change.type === 'document.copy') &&
          change.record.scope.kind === 'conversation'
        ) {
          const value =
            change.type === 'document'
              ? change.value
              : (await host.document(change.record.id, 'current', context))?.value
          if (value !== undefined) await document(change.record, value)
        }
      }
      // A publication's change order is unspecified; entry IDs order its entries.
      for (const value of publication.changes
        .filter((change) => change.type === 'entry')
        .map((change) => change.value)
        .toSorted((a, b) => a.id - b.id))
        entry(value)
      queue()
      summariesDirty = true
    }
    const catchUp = async (cursor: Extract<CloudMessage, { type: 'cursor' }>) => {
      if (ready) throw new Error('Duplicate cloud cursor')
      unsubscribe = host.harness().subscribeCommits((publication) => {
        if (!ready) buffered.push(publication)
        else enqueue(() => live(publication))
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
            for (const value of page.items) if (value.conversationId === record.id) entry(value)
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
              if ((await docHash(stored.value)) !== cursor.docs[String(doc.id)])
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
      for (const publication of buffered) await live(publication)
      buffered = []
      ready = true
      queue()
    }
    const close = () => {
      if (closed) return
      closed = true
      unsubscribe?.()
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
    },
  )
}

export default function cloud(host: ExtensionHost) {
  const url = process.env.ULTIMATE_CLOUD_URL
  if (url) {
    let stop: ReturnType<typeof startSync> | undefined
    host.onOpen(async () => {
      stop = startSync(
        host,
        url,
        process.env.ULTIMATE_CLOUD_TOKEN ?? '',
        process.env.ULTIMATE_CLOUD_MACHINE ?? hostname(),
      )
    })
    host.onClose(async () => {
      stop?.()
      await stop?.idle()
    })
  }
  return defineExtension({ name: 'cloud' })
}
