import { ReplicaStore, proxyRequest } from './replica.ts'
import type { Sql } from './replica.ts'
import type { MachineMessage } from './protocol.ts'
import type { ConversationSummary } from '../shared/protocol.ts'

interface Env {
  REPLICA: DurableObjectNamespace
  ASSETS: Fetcher
  MACHINE_ORIGIN: string
  SYNC_TOKEN: string
}

export default {
  fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname
    if (path.startsWith('/api/') || path === '/sync')
      return env.REPLICA.get(env.REPLICA.idFromName('default')).fetch(request)
    return env.ASSETS.fetch(request)
  },
}

export class Replica {
  readonly ctx: DurableObjectState
  readonly env: Env
  readonly store: ReplicaStore
  readonly streams = new Set<{
    id: number
    send(name: string, value: unknown): void
    close(): void
  }>()
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
    this.store = new ReplicaStore({
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (run) => ctx.storage.transactionSync(run),
    } as Sql)
  }
  sockets() {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN)
  }
  refresh() {
    for (const stream of this.streams) stream.send('view', this.store.view(stream.id))
  }
  webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    if (!this.sockets().includes(socket)) return
    const message = JSON.parse(
      typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
    ) as MachineMessage
    for (const reply of this.store.receive(message)) socket.send(JSON.stringify(reply))
    if (message.type === 'delivered') this.refresh()
  }
  webSocketClose(socket: WebSocket) {
    socket.close()
  }
  webSocketError(socket: WebSocket) {
    socket.close(1011, 'Sync failed')
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/sync') {
      if (
        !this.env.SYNC_TOKEN ||
        request.headers.get('Authorization') !== `Bearer ${this.env.SYNC_TOKEN}`
      )
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return new Response('Expected WebSocket', { status: 426 })
      for (const socket of this.sockets()) socket.close(1000, 'Replaced by new machine connection')
      const [client, server] = Object.values(new WebSocketPair())
      this.ctx.acceptWebSocket(server)
      for (const stream of this.streams) stream.close()
      return new Response(null, { status: 101, webSocket: client })
    }
    if (this.sockets().length) {
      try {
        return await fetch(proxyRequest(request.clone(), this.env.MACHINE_ORIGIN))
      } catch {
        // A connected sync socket does not guarantee the HTTP origin is reachable; serve the last replica instead.
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/events') return this.events(request, url)
    if (request.method === 'GET' && url.pathname === '/api/models')
      return Response.json(this.store.metadata(3) ?? { providers: [], models: [] })
    const history = /^\/api\/conversations\/(\d+)\/history$/.exec(url.pathname)
    if (request.method === 'GET' && history) {
      const id = Number(history[1]),
        before = Number(url.searchParams.get('before'))
      if (!Number.isSafeInteger(before) || before < 1)
        return Response.json(
          { error: 'Invalid history cursor or conversation id' },
          { status: 400 },
        )
      if (!this.store.conversation(id))
        return Response.json({ error: 'Unknown conversation' }, { status: 404 })
      return Response.json(this.store.history(id, before))
    }
    const submit = /^\/api\/conversations\/(\d+)\/submit$/.exec(url.pathname)
    if (request.method === 'POST' && submit) {
      let data: Record<string, unknown>
      try {
        data = await request.json()
      } catch {
        return Response.json({ error: 'Expected JSON' }, { status: 400 })
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        return Response.json({ error: 'Expected JSON object' }, { status: 400 })
      if (data.images !== undefined && (!Array.isArray(data.images) || data.images.length))
        return Response.json(
          { error: 'Images are unavailable while the machine is offline' },
          { status: 503 },
        )
      if (
        typeof data.text !== 'string' ||
        !data.text.trim() ||
        (data.whenBusy !== undefined && data.whenBusy !== 'steer' && data.whenBusy !== 'followUp')
      )
        return Response.json({ error: 'Expected text and valid whenBusy' }, { status: 400 })
      const { submissionId } = this.store.enqueue(Number(submit[1]), data.text, data.whenBusy)
      for (const socket of this.sockets())
        socket.send(JSON.stringify({ type: 'outbox', items: this.store.outbox() }))
      this.refresh()
      return Response.json({ submissionId }, { status: 202 })
    }
    // Drain unsupported request bodies before replying across the Worker/DO boundary. Cancelling leaves
    // Wrangler's forwarding stream reading after the response, which can turn an expected 503 into a 500.
    if (request.body) await request.arrayBuffer()
    return Response.json({ error: 'The machine is offline', offline: true }, { status: 503 })
  }
  events(request: Request, url: URL) {
    const id = Number(url.searchParams.get('conversation') ?? this.store.root())
    const encoder = new TextEncoder()
    let stop: (() => void) | undefined
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (name: string, value: unknown) =>
          controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`))
        controller.enqueue(encoder.encode('retry: 500\n\n'))
        send('system', { ...(this.store.metadata(2) as object | undefined), offline: true })
        send(
          'conversations',
          ((this.store.metadata(1) as ConversationSummary[] | undefined) ?? []).map((summary) => ({
            ...summary,
            busy: false,
          })),
        )
        send('view', this.store.view(id))
        send('ui', { value: this.store.doc(this.store.root(), 'ultimate.ui') ?? {} })
        send('tasks', { tasks: {} })
        for (const kind of new Set((url.searchParams.get('docs') ?? '').split(',').filter(Boolean)))
          send('doc', { kind, value: this.store.doc(id, kind) })
        send('notice', {
          level: 'warning',
          message: 'The machine is offline. This is the last synced state.',
        })
        const timer = setInterval(
          () => controller.enqueue(encoder.encode(': heartbeat\n\n')),
          15000,
        )
        let closed = false
        const stream = {
          id,
          send,
          close: () => {
            if (closed) return
            closed = true
            clearInterval(timer)
            this.streams.delete(stream)
            request.signal.removeEventListener('abort', stream.close)
            if (!cancelled) controller.close()
          },
        }
        stop = stream.close
        this.streams.add(stream)
        request.signal.addEventListener('abort', stop, { once: true })
        if (request.signal.aborted) stream.close()
      },
      cancel: () => {
        cancelled = true
        stop?.()
      },
    })
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })
  }
}
