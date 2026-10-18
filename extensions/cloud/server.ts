import { existsSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
  CommitPublication,
  ConversationId,
  Cursor,
  DocumentRecord,
  DocumentId,
  EntryId,
  JsonObject,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
  docHash,
  HELLO_LIMITS,
  PROJECT_KEY,
  PROJECT_MISMATCH,
  validTailnet,
} from '../../cloud/protocol.ts'
import type {
  CloudMessage,
  MachineMessage,
  ReplicaDoc,
  Transition,
  Writer,
} from '../../cloud/protocol.ts'
import { projectBuilds } from '../../cloud/ui-build.ts'
import { secretMetadata } from '../secrets/store.ts'
import type { TailscaleService } from '../tailscale/server.ts'
import { cloudConfig, leaseSettings } from './config.ts'
import { projectIdentity } from './identity.ts'
import { startLease } from './lease.ts'
import type { Lease, LeaseDeps } from './lease.ts'
import type { CloudState, SyncProgress } from './types.ts'
import * as snapshot from './snapshot.ts'

export const secrets = [
  { name: 'ULTIMATE_CLOUD_TOKEN', description: 'Bearer token for the cloud sync endpoint' },
  {
    name: 'ULTIMATE_CLOUD_SNAPSHOT_KEY',
    description:
      'Encrypts project snapshots moved between machines; use the same value on every machine',
  },
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
/** How often the user's secret names are compared with the ones the cloud last heard. */
export const SECRETS_CHECK = 5000
/** A connection open this long that drops (a deploy restarting the replica) reconnects at once, without backoff. */
export const QUICK_RECONNECT_AFTER = 10_000

/** This machine's place in the project: the last role the cloud gave it, kept across reconnects. */
export interface SyncState {
  key: string
  connected: boolean
  role?: 'writer' | 'standby'
  epoch?: number
  /** The lease is free: a standby may claim it at `epoch`. */
  free?: boolean
  snapshot?: { id: string; epoch: number }
  writer?: Writer
  /** The latest move the cloud reported, running or ended. */
  transition?: Transition
  /** The replica's project key, under which its snapshots live. */
  project?: { key: string }
}

export interface SyncOptions {
  url: string
  token: string
  machine: string
  identity: { key: string; rootCommit: string }
}

/** How a connection serves the lease lifecycle (`lease.ts`). */
export interface SyncHooks {
  /**
   * The harness is open, so this connection syncs as the writer. Without it the machine is on standby: it never sends
   * data and ignores `cursor` and `outbox`, whatever its role.
   */
  serving: boolean
  /** Each role, once the state holds it, from inside the message chain: defer any lifecycle switch. */
  role?(state: SyncState): void
  /** The writer hears that the standby `by` asked for the lease, for transition `id`; `force` skips its holds. */
  releaseRequested?(by: string, id: string, force: boolean): void
  /**
   * The requester hears what the writer's release waits for: `tasks` running tasks of the conversations `runs`, then
   * its worktrees with uncommitted changes (`dirty` with `held`), or the ones that stay behind (`dirty` alone).
   */
  releaseWaiting?(waiting: Omit<Extract<CloudMessage, { type: 'release-waiting' }>, 'type'>): void
  /** The cloud UI or @sync (`by`) asks this standby to take the lease as transition `id`. */
  moveTo?(id: string, force: boolean, by: 'cloud' | 'sync'): void
  /** The cloud UI stops transition `id`. */
  cancel?(id: string): void
  /** The transition this machine prepares, named in hello so the cloud keeps it. */
  transition?(): string | undefined
  /** A connection after the first said hello: its first role answers what an earlier one left unanswered. */
  hello?(): void
}

/** One outbound connection; injected transport keeps sync tests entirely in process. */
export function startSync(
  host: ExtensionHost,
  { url, token, machine, identity }: SyncOptions,
  dial = connect,
  builds?: ReturnType<typeof projectBuilds>,
  hooks: SyncHooks = { serving: true },
) {
  const { serving } = hooks
  let socketSend: ((message: MachineMessage) => boolean) | undefined
  let stopped = false
  let retry = 1000
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let dispose: (() => void) | undefined
  let idle: (() => Promise<void>) | undefined
  let retainedBytes: (() => number) | undefined
  let progress: (() => SyncProgress) | undefined
  let state: SyncState = { key: identity.key, connected: false }
  const leasePath = join(host.home, 'cloud-lease.json')
  const readLease = async () => {
    try {
      const lease = JSON.parse(await readFile(leasePath, 'utf8')) as {
        key?: unknown
        epoch?: unknown
      }
      return lease.key === identity.key && Number.isSafeInteger(lease.epoch)
        ? (lease.epoch as number)
        : undefined
    } catch {
      // No lease yet, or an unreadable one: hello names no epoch, and the writer's role rewrites it.
      return undefined
    }
  }
  /** A claim in flight (`lease.ts`) names the epoch it wins, so the replica knows this machine as that writer. */
  const claimEpoch = async () => {
    try {
      const intent = JSON.parse(await readFile(join(host.home, 'cloud-claim.json'), 'utf8')) as {
        key?: unknown
        epoch?: unknown
      }
      return intent.key === identity.key && Number.isSafeInteger(intent.epoch)
        ? (intent.epoch as number) + 1
        : undefined
    } catch {
      // No claim in flight.
      return undefined
    }
  }
  const writeLease = async (epoch: number) => {
    if ((await readLease()) === epoch) return
    await writeFile(`${leasePath}.tmp`, JSON.stringify({ key: identity.key, epoch }))
    await rename(`${leasePath}.tmp`, leasePath)
  }
  // On standby, `<home>/cloud-writer.json` names the machine running the project and its tailnet address, so the
  // `ultimate` command opens that machine directly. It goes away when this checkout writes or the writer has none.
  const writerPath = join(host.home, 'cloud-writer.json')
  let lastWriter: string | undefined
  const recordWriter = async (writer: Writer | undefined) => {
    const value =
      writer?.machine && writer.machine !== machine && writer.tailnet
        ? JSON.stringify({ machine: writer.machine, tailnet: writer.tailnet })
        : ''
    if (value === lastWriter) return
    lastWriter = value
    if (!value) return rm(writerPath, { force: true })
    await writeFile(`${writerPath}.tmp`, value)
    await rename(`${writerPath}.tmp`, writerPath)
  }
  /** Where this checkout answers on the tailnet, once the `tailscale` extension published it. */
  const tailnet = () => {
    const published = host.use<TailscaleService>('tailscale')?.status().url
    return validTailnet(published) ? published : undefined
  }
  /** Secret names the cloud accepts, and whether that is every one in the store. */
  const secretNames = async () => {
    try {
      const all = (await secretMetadata(host.userHome)).map((secret) => secret.name)
      const names = all
        .filter((name) => HELLO_LIMITS.secret.test(name))
        .slice(0, HELLO_LIMITS.secrets)
      return { secrets: names, secretsComplete: names.length === all.length }
    } catch {
      // The Secrets panel reports an unreadable store; until it is repaired this machine cannot vouch for any.
      return { secrets: [], secretsComplete: false }
    }
  }
  const hasHistory = async () =>
    // A standby's storage is closed; any database it kept is its own history.
    !serving
      ? existsSync(join(host.home, 'state.sqlite'))
      : host
          .harness()
          .commit(
            async (tx) =>
              (await tx.scanConversations({}, 2)).items.length > 1 ||
              (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)).items.length > 0,
            context,
          )
  const open = () => {
    if (stopped) return
    let socket: SyncSocket
    try {
      const endpoint = new URL(url)
      endpoint.pathname = '/sync/v2'
      endpoint.search = ''
      endpoint.searchParams.set('project', identity.key)
      socket = dial(endpoint.href, token)
    } catch (error) {
      host.notice(`Cloud connection failed: ${String(error)}`)
      schedule()
      return
    }
    let closed = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let metadataTimer: ReturnType<typeof setInterval> | undefined
    let secretsTimer: ReturnType<typeof setInterval> | undefined
    let openedAt: number | undefined
    let summariesDirty = true
    let role: SyncState['role']
    let ready = false
    let batch = 0
    const unacked = new Map<number, number>()
    let lastAckAt: number | undefined
    // Catch-up progress: conversations whose entries and documents were all queued, of those the host lists.
    let catchingUp = false
    let synced = 0
    let total = 0
    progress = () => ({
      connected: state.connected,
      catchingUp,
      backlog: unacked.size + (catchingUp ? Math.max(0, total - synced) : 0),
      ...(lastAckAt === undefined ? {} : { lastAckAt }),
      ...(catchingUp || total ? { conversations: { synced, total } } : {}),
    })
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
    let lastSummaries: Map<number, string> | undefined
    let lastSystem = ''
    let lastSystemAt = 0
    const send = (message: MachineMessage) => {
      if (!closed) socket.send(JSON.stringify(message))
    }
    socketSend = (message) => {
      if (closed || !role) return false
      send(message)
      return true
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
        unacked.set(next.batch, Date.now())
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
    let lastUiBuild: string | undefined
    const metadata = () => {
      const uiBuild = builds?.current()
      if (uiBuild && uiBuild !== lastUiBuild) {
        send({ type: 'uiBuild', value: uiBuild })
        lastUiBuild = uiBuild
      }
      const oldest = unacked.values().next().value
      if (oldest !== undefined && Date.now() - oldest > 60_000) {
        host.notice('Cloud sync stalled: no acknowledgement for 60 s; reconnecting')
        close()
        return
      }
      const system = host.system()
      // RAM and SQLite sizes change constantly; keep them fresh once a minute without
      // resending the full Info snapshot on every system refresh.
      const systemJson = JSON.stringify({
        ...system,
        machine: { ...system.machine, freeMemory: undefined },
        persistence: { ...system.persistence, sizeBytes: undefined, walBytes: undefined },
      })
      if (summariesDirty) {
        summariesDirty = false
        const summaries = host.conversations()
        // An open host always has a root; an empty list means it is opening or closing.
        if (summaries.length) {
          const current = new Map(summaries.map((summary) => [summary.id, JSON.stringify(summary)]))
          const value = summaries.filter(
            (summary) => current.get(summary.id) !== lastSummaries?.get(summary.id),
          )
          const removed = [...(lastSummaries?.keys() ?? [])].filter((id) => !current.has(id))
          if (!lastSummaries || value.length || removed.length)
            send({ type: 'summaries', value, removed, full: lastSummaries === undefined })
          lastSummaries = current
        }
      }
      if (systemJson !== lastSystem || Date.now() - lastSystemAt >= 60_000) {
        lastSystem = systemJson
        lastSystemAt = Date.now()
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
      catchingUp = true
      synced = 0
      total = host.conversations().length
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
          synced++
          total = Math.max(total, synced)
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
      catchingUp = false
      await drainChanges()
      queue()
    }
    const close = () => {
      if (closed) return
      closed = true
      state = { ...state, connected: false }
      catchingUp = false
      clearInterval(secretsTimer)
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
      // A connection that had been up a while dropped, as a deploy restarting the replica does: try again at once.
      // Backoff applies from the next failure on, so a socket that never opens, or keeps closing soon, waits.
      if (!stopped)
        schedule(
          openedAt !== undefined && Date.now() - openedAt >= QUICK_RECONNECT_AFTER ? 0 : undefined,
        )
    }
    dispose = close
    // The user's secret names and the tailnet address travel in hello, then whenever they change, so missing secrets
    // stay current and the address shows once Tailscale published it.
    let lastSecrets: string | undefined
    let lastTailnet: string | null | undefined
    socket.addEventListener('open', () => {
      openedAt = Date.now()
      secretsTimer = setInterval(
        () =>
          enqueue(async () => {
            if (!role || lastSecrets === undefined) return
            const address = tailnet() ?? null
            if (address !== lastTailnet) {
              lastTailnet = address
              send({ type: 'tailnet', url: address })
            }
            const current = await secretNames()
            if (JSON.stringify(current) === lastSecrets) return
            lastSecrets = JSON.stringify(current)
            send({ type: 'secrets', ...current })
          }),
        SECRETS_CHECK,
      )
      enqueue(async () => {
        hooks.hello?.()
        const names = await secretNames()
        lastSecrets = JSON.stringify(names)
        const address = tailnet()
        lastTailnet = address ?? null
        send({
          type: 'hello',
          key: identity.key,
          rootCommit: identity.rootCommit,
          root: host.projectRoot,
          machine,
          build: host.build().id,
          uiBuild: builds?.current(),
          port: Number(new URL(host.system().process.url).port),
          epoch: (await claimEpoch()) ?? (await readLease()),
          history: await hasHistory(),
          ...names,
          ...(hooks.transition?.() ? { transition: hooks.transition() } : {}),
          ...(address ? { tailnet: address } : {}),
        })
      })
    })
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as CloudMessage
        if (message.type === 'role')
          enqueue(async () => {
            const { type: _, ...given } = message
            // On standby the lease module records the epoch once it opens storage as the writer.
            if (message.role === 'writer' && serving) await writeLease(message.epoch)
            state = { key: identity.key, connected: true, ...given }
            hooks.role?.(state)
            await recordWriter(message.role === 'standby' ? message.writer : undefined)
            // On standby nothing was sent, so a changed role needs no fresh hello.
            if (!serving) {
              role = message.role
              retry = 1000
              return
            }
            // A role that changes on an open socket starts over with a fresh hello.
            if (role && role !== message.role) return close()
            if (role) return
            role = message.role
            // A standby only listens for role updates; it sends no data, which fences it off.
            if (role !== 'writer') {
              retry = 1000
              return
            }
            builds?.connect()
            metadata()
            metadataTimer = setInterval(metadata, 1000)
            send({ type: 'models', value: await host.modelsResponse() })
          })
        else if (message.type === 'ack') {
          unacked.delete(message.batch)
          lastAckAt = Date.now()
          flush()
          capacity?.()
          capacity = undefined
        } else if (message.type === 'release-requested')
          hooks.releaseRequested?.(message.by, message.id, message.force === true)
        else if (message.type === 'release-waiting') hooks.releaseWaiting?.(message)
        else if (message.type === 'move-to')
          hooks.moveTo?.(
            message.id,
            message.force === true,
            message.by === 'sync' ? 'sync' : 'cloud',
          )
        else if (message.type === 'cancel') hooks.cancel?.(message.id)
        // A claim on standby gets `cursor` and `outbox` too; the reopened, serving connection catches up.
        else if (!serving) return
        else if (message.type === 'cursor')
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
    socket.addEventListener('close', (event) => {
      if (closed) return
      if (event.code === PROJECT_MISMATCH) {
        stopped = true
        host.notice(
          `Cloud sync stopped: the cloud refused ${identity.key} (${event.reason}); use cloud.relink if the repository was renamed.`,
        )
      }
      close()
    })
    socket.addEventListener('error', close)
  }
  /** Reconnect after `delay`, or after the backoff, which doubles each time it is used. */
  const schedule = (delay?: number) => {
    reconnect = setTimeout(open, delay ?? retry)
    if (delay === undefined) retry = Math.min(30_000, retry * 2)
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
      state: () => state,
      /** The connection's catch-up and acknowledgement window, for operators. */
      progress: (): SyncProgress =>
        progress?.() ?? { connected: false, catchingUp: false, backlog: 0 },
      /** Send a lease message on the admitted socket; false while none is. */
      send: (message: MachineMessage) => socketSend?.(message) ?? false,
    },
  )
}

let active: Lease | undefined
/** Sync is configured, but the project has no GitHub origin: it runs here only. */
let localOnly = false
const serving = (host: ExtensionHost) => {
  try {
    host.harness()
    return true
  } catch {
    // Not open yet, or on standby.
    return false
  }
}
/** This machine's name, while sync runs. */
let machine: string | undefined

/** This process's sync role, or undefined while sync is off. */
export function syncState(): SyncState | undefined {
  return active?.sync()?.state()
}

export const actions = {
  /**
   * `{status, machine, role, free, writer, missing, blocked, progress, transition, sync, lastError}` for the cloud UI.
   */
  state: async (): Promise<CloudState> =>
    active
      ? {
          ...(await active.state()),
          status: 'on',
          machine,
          ...(active.sync() ? { sync: active.sync()!.progress() } : {}),
        }
      : { free: false, missing: [], status: localOnly ? 'local' : 'off' },
  /**
   * `{force?, by?}`: prepare this machine and take the project, from a free lease or from the online writer. Resolves
   * the transition ID at once; `state` follows its steps. `force` continues although the writer has secrets this
   * machine lacks. `by: 'sync'` records @sync as the move's initiator; otherwise it is this machine's page.
   */
  moveHere: async (args: JsonValue) => {
    if (!active) throw new Error('Cloud sync is off')
    const { force, by } = (args ?? {}) as { force?: unknown; by?: unknown }
    return active.moveHere({ force: force === true, by: by === 'sync' ? 'sync' : 'local' })
  },
  /** Stop the preparing move, until its claim is sent. */
  cancel: async () => {
    if (!active) throw new Error('Cloud sync is off')
    active.cancel()
    return { ok: true }
  },
  /**
   * `{from}`: sync this project's key to the replica of `from` from now on, after a repository rename or a root-commit
   * mismatch. The cloud names the epoch again on the next hello.
   */
  relink: async (args: JsonValue, { host }: ActionContext) => {
    const from = (args as { from?: unknown } | null)?.from
    if (typeof from !== 'string' || !PROJECT_KEY.test(from))
      throw new Error('Expected {from: "github.com/<owner>/<repo>"}')
    const config = await cloudConfig(host)
    const identity = await projectIdentity(host.projectRoot)
    if (!config || !identity) throw new Error('Cloud sync is off')
    if (from === identity.key) throw new Error(`${from} is this project's own key`)
    const endpoint = new URL(config.url)
    endpoint.protocol = endpoint.protocol === 'ws:' ? 'http:' : 'https:'
    endpoint.pathname = '/sync/relink'
    endpoint.search = ''
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: identity.key, from }),
    })
    if (!response.ok) throw new Error(`Relink failed: ${response.status} ${await response.text()}`)
    // The epoch was another replica's; without one the writer machine is the writer again.
    const lease = join(host.home, 'cloud-lease.json')
    const held = JSON.parse(await readFile(lease, 'utf8').catch(() => '{}')) as { key?: string }
    if (held.key === identity.key) await rm(lease)
    active?.restart()
    return { key: identity.key, from }
  },
}
export const userActions = ['moveHere', 'cancel', 'relink']

/**
 * With cloud sync on, a home opens storage only as this project's writer: one whose `cloud-lease.json` names `key`.
 * Any other home, new or holding a database the cloud never admitted, starts on standby until the cloud names its
 * role, however long that takes, so a machine the cloud did not admit never writes. As the first machine of a new
 * project the lease activates it as the writer, with its own database. Runs before the server opens storage. True
 * when this home starts on standby.
 */
export async function joinOnStandby(home: string, key: string) {
  const path = join(home, 'standby.json')
  if (existsSync(path)) return false
  try {
    const lease = JSON.parse(await readFile(join(home, 'cloud-lease.json'), 'utf8')) as {
      key?: unknown
    }
    if (lease.key === key) return false
  } catch {
    // No lease file: this home never held the project's lease.
  }
  await writeFile(
    `${path}.tmp`,
    JSON.stringify({ reason: 'Waiting for the cloud', joining: true, cloud: true }),
  )
  await rename(`${path}.tmp`, path)
  return true
}

export default async function cloud(host: ExtensionHost, deps: Partial<LeaseDeps> = {}) {
  // The process stopping, not a reload of this facet, releases the lease.
  const stopping = host.resource('cloud.process', () => {
    const current: { lease?: Lease } = {}
    host.onClose(async () => current.lease?.stopRelease())
    return current
  })
  let lease: Lease | undefined
  let builds: ReturnType<typeof projectBuilds> | undefined
  let closed = false
  const ready = (async () => {
    const config = await cloudConfig(host)
    if (!config) return
    const identity = await projectIdentity(host.projectRoot)
    if (!identity) {
      localOnly = true
      host.notice(`Cloud sync is off: ${host.projectRoot} has no GitHub origin remote.`)
      return
    }
    if (closed) return
    // A reload of this facet while storage is open changes nothing.
    if (!serving(host)) await joinOnStandby(host.home, identity.key)
    machine = config.machine
    builds = deps.builds ?? projectBuilds(host, config.url, config.token)
    lease = startLease(
      host,
      { ...config, identity, ...(await leaseSettings(host)) },
      { sync: startSync, dial: connect, snapshots: snapshot, builds, ...deps },
    )
    stopping.lease = active = lease
  })()
  host.onOpen(async () => {
    await ready
    lease?.opened()
  })
  host.onRelease(async () => {
    await ready
    lease?.released()
  })
  host.onClose(async () => {
    closed = true
    await ready
    lease?.close()
    if (active === lease) active = machine = undefined
    localOnly = false
    await builds?.stop()
    await lease?.sync()?.idle()
  })
  // A joining machine is on standby before the server opens storage.
  await ready
  return defineExtension({ name: 'cloud' })
}
