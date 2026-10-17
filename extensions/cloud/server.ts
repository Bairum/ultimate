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
            bytes += JSON.stringify(value).length
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
      if (JSON.stringify(pending).length >= 1_000_000) flush()
      else timer ??= setTimeout(flush, 250)
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
      if (index < 0) pending.docs.push(doc)
      else pending.docs[index] = doc
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
        if (change.type === 'conversation') pending.conversations.push(change.value)
        else if (change.type === 'entry') pending.entries.push(change.value)
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
      pending.entries.sort((a, b) => a.id - b.id)
      queue()
      summariesDirty = true
    }
    const catchUp = async (cursor: Extract<CloudMessage, { type: 'cursor' }>) => {
      if (ready) throw new Error('Duplicate cloud cursor')
      unsubscribe = host.harness().subscribeCommits((publication) => {
        if (!ready) buffered.push(publication)
        else enqueue(() => live(publication))
      })
      const records = await host.harness().commit(async (tx) => {
        const scanned = []
        let pageCursor: Cursor | undefined
        do {
          const page = await tx.scanConversations({}, 256, pageCursor)
          scanned.push(...page.items)
          pageCursor = page.next
        } while (pageCursor)
        for (const record of scanned) {
          let entryCursor: Cursor | undefined
          do {
            const page = await tx.scanEntries(
              {
                conversationId: record.id,
                minEntryId: (cursor.maxEntryId + 1) as EntryId,
                order: 'ascending',
              },
              256,
              entryCursor,
            )
            pending.entries.push(
              ...page.items.filter((entry) => entry.conversationId === record.id),
            )
            entryCursor = page.next
          } while (entryCursor)
        }
        return scanned
      }, context)
      pending.conversations.push(...records)
      pending.entries.sort((a, b) => a.id - b.id)
      const seen = new Set<number>()
      for (const record of records) {
        let docCursor: Cursor | undefined
        do {
          const page = await host.scanDocuments(
            { scope: { kind: 'conversation', conversationId: record.id }, at: 'current' },
            256,
            docCursor,
            context,
          )
          for (const doc of page.items) {
            const stored = await host.document(doc.id, 'current', context)
            if (!stored) continue
            seen.add(doc.id)
            if ((await docHash(stored.value)) !== cursor.docs[String(doc.id)])
              await document(doc, stored.value)
          }
          docCursor = page.next
        } while (docCursor)
      }
      // A retired incarnation is absent locally. Only its ID matters for deletion at the replica.
      for (const id of Object.keys(cursor.docs)) {
        if (!seen.has(Number(id)))
          pending.docs.push({
            id: Number(id),
            kind: '',
            conversationId: 0,
            value: null,
            hash: await docHash(null),
          })
      }
      flush()
      for (const publication of buffered) await live(publication)
      buffered = []
      ready = true
      queue()
    }
    const close = () => {
      if (closed) return
      closed = true
      unsubscribe?.()
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
      enqueue(async () => send({ type: 'models', value: await host.models() }))
    })
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as CloudMessage
        if (message.type === 'ack') {
          unacked.delete(message.batch)
          flush()
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
