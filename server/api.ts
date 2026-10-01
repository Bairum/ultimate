import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineDoc } from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, DocumentWatch, JsonObject } from '@earendil-works/pi-durable'
import type { ServerEvents, ConversationSummary, ConfigureRequest } from '../shared/protocol.ts'
import { AuthBridge, listModels } from './auth.ts'
import type { Extensions } from './extensions.ts'
import { context } from './harness.ts'
import type { OpenHost, PreparedHost } from './harness.ts'
import type { createSystem } from './system.ts'
import { requestSwap } from './supervisor-protocol.ts'
import { UiState } from './ui-state.ts'
import type { JsonValue } from '@earendil-works/chord'
import { SubagentInfo } from '../extensions/subagents/server.ts'

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export class Events {
  readonly listeners = new Set<
    (name: keyof ServerEvents, data: ServerEvents[keyof ServerEvents]) => void
  >()
  emit<K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) {
    for (const listener of this.listeners) listener(name, data)
  }
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let data = ''
  request.setEncoding('utf8')
  for await (const chunk of request) {
    data += chunk.toString()
    if (Buffer.byteLength(data) > 1024 * 1024) throw new HttpError(413, 'Request too large')
  }
  try {
    const value = JSON.parse(data || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new HttpError(400, 'Expected a JSON object')
  }
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Expected ${name}`)
  return value
}
const Metadata = defineDoc<{ title?: string }>({
  kind: 'ultimate.metadata',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
const validUiKey = (key: unknown) =>
  typeof key === 'string' && key.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(key)
const thinking = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
export async function createApi(
  host: PreparedHost,
  opened: OpenHost,
  events: Events,
  system: Awaited<ReturnType<typeof createSystem>>,
  extensions: Extensions,
) {
  const { harness, root } = opened
  const auth = new AuthBridge(host.modelRuntime, (event) => events.emit('auth', event))
  const streams = new Set<() => Promise<void>>()
  const graph = await harness.taskGraph(context)
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let summaries: ConversationSummary[] = []
  let refreshing = Promise.resolve()
  async function refreshConversations(ids?: Set<ConversationId>) {
    const records = await harness.commit(async (tx) => {
      if (ids)
        return (await Promise.all([...ids].map((id) => tx.conversation(id)))).filter(
          (record) => record !== undefined,
        )
      const scanned = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        scanned.push(...page.items)
        cursor = page.next
      } while (cursor !== undefined)
      return scanned
    }, context)
    const next: ConversationSummary[] = ids ? [...summaries] : []
    for (const record of records) {
      const conversation = await harness.conversation(record.id, context)
      if (!conversation) continue
      const view = await conversation.viewState(context)
      const agent = await conversation.agent(context)
      const metadata = await harness.snapshot(Metadata, record.id, context)
      const subagent = await harness.snapshot(SubagentInfo, record.id, context)
      const input = view.value.entries.find((entry) => entry.kind === 'pi.user')?.model?.[0]
      const title =
        input?.role === 'user'
          ? typeof input.content === 'string'
            ? input.content
            : input.content
                .flatMap((block) => (block.type === 'text' ? [block.text] : []))
                .join(' ')
          : undefined
      const summary: ConversationSummary = {
        id: record.id,
        ...(record.owner || record.parent
          ? { parentConversationId: record.owner?.conversationId ?? record.parent?.conversationId }
          : {}),
        ...(record.owner ? { ownerTaskId: record.owner.taskId } : {}),
        ...(subagent?.agent ? { agent: subagent.agent, background: subagent.background } : {}),
        ...(subagent?.title || metadata?.title
          ? { title: subagent?.title ?? metadata?.title }
          : title
            ? { title: title.replace(/\s+/g, ' ').slice(0, 160) }
            : {}),
        cwd: agent.cwd,
        busy: Object.values(graph.value.tasks).some(
          (task) => task.conversationId === record.id && !task.background,
        ),
      }
      const index = next.findIndex((item) => item.id === record.id)
      if (index < 0) next.push(summary)
      else next[index] = summary
      view.dispose()
    }
    if (JSON.stringify(next) !== JSON.stringify(summaries)) {
      summaries = next
      events.emit('conversations', summaries)
    }
  }
  await refreshConversations()
  let lastGraph = JSON.stringify(graph.value)
  const unsubscribeGraph = graph.subscribe(() => {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      const current = JSON.stringify(graph.value)
      if (current !== lastGraph) {
        lastGraph = current
        events.emit('tasks', graph.value)
        const next = summaries.map((summary) => ({
          ...summary,
          busy: Object.values(graph.value.tasks).some(
            (task) => task.conversationId === summary.id && !task.background,
          ),
        }))
        if (JSON.stringify(next) !== JSON.stringify(summaries)) {
          summaries = next
          events.emit('conversations', summaries)
        }
      }
    }, 100)
  })
  const unsubscribe = harness.subscribeCommits((publication) => {
    if (closed) return
    const ids = new Set<ConversationId>()
    for (const change of publication.changes) {
      if (change.type === 'conversation') ids.add(change.value.id)
      if (change.type === 'entry' && change.value.kind === 'pi.user')
        ids.add(change.value.conversationId)
      if (
        change.type === 'document' &&
        change.conversationId &&
        (change.record.kind === 'ultimate.metadata' ||
          change.record.kind === 'ultimate.subagent' ||
          (change.record.kind === 'pi.agent' &&
            change.ops.some((op) => op[0] === 'r' || op[1][0] === 'cwd')))
      )
        ids.add(change.conversationId)
    }
    if (!ids.size) return
    refreshing = refreshing
      .then(() => refreshConversations(ids))
      .catch(() =>
        events.emit('notice', { level: 'error', message: 'Could not refresh conversation list' }),
      )
  })
  async function stream(
    request: IncomingMessage,
    response: ServerResponse,
    id: ConversationId,
    kinds: string[],
  ) {
    const conversation = await harness.conversation(id, context)
    if (!conversation) throw new HttpError(404, 'Unknown conversation')
    const docs: { kind: string; watch: DocumentWatch<JsonObject> }[] = []
    const unknown: string[] = []
    for (const kind of new Set(kinds)) {
      const token = extensions.doc(kind)
      if (!token) {
        unknown.push(kind)
        continue
      }
      await conversation.commit(async (tx) => {
        await tx.doc(token, id)
      }, context)
      const watch = await harness.watchDoc(token, id, context)
      if (watch) docs.push({ kind, watch })
    }
    const ui = await harness.watchDoc(UiState, root.id, context)
    const watch = await conversation.watch(context)
    const send = (name: keyof ServerEvents, data: ServerEvents[keyof ServerEvents]) => {
      if (!response.destroyed) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.write('retry: 500\n\n')
    send('system', system.current())
    send('conversations', summaries)
    send('view', watch.value)
    send('ui', { value: ui!.value! })
    ui!.start(async (_value, ops) => {
      send('uiOps', { ops })
    })
    send('tasks', graph.value)
    for (const kind of unknown)
      send('notice', { level: 'warning', message: `Unknown extension document: ${kind}` })
    for (const doc of docs) {
      send('doc', { kind: doc.kind, value: doc.watch.value })
      doc.watch.start(async (_value, ops) => {
        send('docOps', { kind: doc.kind, ops })
      })
    }
    events.listeners.add(send)
    watch.start(async (_value, ops) => {
      send('ops', ops)
    })
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': heartbeat\n\n')
    }, 15000)
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      clearInterval(heartbeat)
      events.listeners.delete(send)
      streams.delete(stop)
      await watch.stop()
      await ui!.stop()
      await Promise.all(docs.map((doc) => doc.watch.stop()))
      response.end()
    }
    streams.add(stop)
    response.on('close', () => {
      void stop()
    })
    if (request.destroyed || response.destroyed) await stop()
  }
  return {
    auth,
    async handle(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/api/')) return false
      const json = (status: number, data: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(data))
      }
      try {
        // Local-only does not mean safe from cross-origin browser requests.
        const origin = request.headers.origin
        if (origin && origin !== system.current().process.url)
          throw new HttpError(403, 'Invalid origin')
        if (request.method === 'GET' && url.pathname === '/api/events') {
          const selected = url.searchParams.get('conversation')
          const id = selected === null ? root.id : Number(selected)
          if (!Number.isSafeInteger(id) || id < 1)
            throw new HttpError(400, 'Invalid conversation id')
          await stream(
            request,
            response,
            id as ConversationId,
            (url.searchParams.get('docs') ?? '').split(',').filter(Boolean),
          )
          return true
        }
        if (request.method === 'GET' && url.pathname === '/api/models') {
          json(200, await listModels(host.modelRuntime, host.faux))
          return true
        }
        if (request.method !== 'POST') throw new HttpError(404, 'Unknown endpoint')
        const data = await body(request)
        if (url.pathname === '/api/ui') {
          const set = data.set === undefined ? {} : data.set
          const remove = data.delete === undefined ? [] : data.delete
          if (!set || typeof set !== 'object' || Array.isArray(set) || !Array.isArray(remove))
            throw new HttpError(400, 'Invalid UI update')
          if (!Object.keys(set).every(validUiKey) || !remove.every(validUiKey))
            throw new HttpError(400, 'Invalid UI key')
          await root.commit(async (tx) => {
            const value = await tx.doc(UiState, root.id)
            const next = { ...value, ...(set as Record<string, JsonValue>) }
            for (const key of remove) delete next[key]
            if (Buffer.byteLength(JSON.stringify(next)) > 256 * 1024)
              throw new HttpError(413, 'UI state too large')
            for (const [key, item] of Object.entries(set)) value[key] = item as JsonValue
            for (const key of remove) delete value[key]
          }, context)
          json(200, { ok: true })
          return true
        }
        if (url.pathname === '/api/restart') {
          const error = await requestSwap(async (generation) => {
            json(202, { ok: true, generation })
          }, host.build())
          if (!response.writableEnded) json(500, { ok: false, error })
          return true
        }
        if (url.pathname === '/api/conversations') {
          const cwd = data.cwd === undefined ? host.repoRoot : text(data.cwd, 'cwd')
          const title = data.title === undefined ? undefined : text(data.title, 'title')
          const agent = await root.agent(context)
          const created = await harness.createConversation(
            {
              ownership: { kind: 'ownerless' },
              agent: { cwd, model: agent.model, thinkingLevel: agent.thinkingLevel },
            },
            context,
          )
          if (title)
            await created.commit(async (tx) => {
              ;(await tx.doc(Metadata, created.id)).title = title
            }, context)
          await refreshing
          json(201, { id: created.id })
          return true
        }
        const match = /^\/api\/conversations\/(\d+)\/(submit|abort|configure|compact)$/.exec(
          url.pathname,
        )
        if (match) {
          const conversation = await harness.conversation(
            Number(match[1]) as ConversationId,
            context,
          )
          if (!conversation) throw new HttpError(404, 'Unknown conversation')
          switch (match[2]) {
            case 'submit': {
              if (
                data.whenBusy !== undefined &&
                data.whenBusy !== 'steer' &&
                data.whenBusy !== 'followUp'
              )
                throw new HttpError(400, 'Invalid whenBusy')
              const submission = await conversation.submit(
                { type: 'input', content: text(data.text, 'text'), whenBusy: data.whenBusy },
                context,
              )
              json(202, { submissionId: submission.id })
              break
            }
            case 'abort':
              await conversation.abort(context)
              json(200, { ok: true })
              break
            case 'configure': {
              if (
                data.thinkingLevel !== undefined &&
                (typeof data.thinkingLevel !== 'string' || !thinking.has(data.thinkingLevel))
              )
                throw new HttpError(400, 'Invalid thinking level')
              if (data.model !== undefined) {
                if (!data.model || typeof data.model !== 'object')
                  throw new HttpError(400, 'Invalid model')
                const model = data.model as Record<string, unknown>
                const provider = text(model.provider, 'model.provider'),
                  modelId = text(model.modelId, 'model.modelId')
                if (
                  !(
                    provider === 'faux' &&
                    modelId === 'faux-1' &&
                    (process.env.ULTIMATE_FAUX === '1' ||
                      (await root.agent(context)).model?.provider === 'faux')
                  ) &&
                  !host.modelRuntime
                    .getAvailableSnapshot()
                    .some(
                      (candidate) => candidate.provider === provider && candidate.id === modelId,
                    )
                )
                  throw new HttpError(400, 'Model is not available')
              }
              const configure: ConfigureRequest = {}
              if (data.model !== undefined)
                configure.model = data.model as ConfigureRequest['model']
              if (data.thinkingLevel !== undefined)
                configure.thinkingLevel = data.thinkingLevel as ConfigureRequest['thinkingLevel']
              await conversation.configure(configure, context)
              json(200, { ok: true })
              break
            }
            case 'compact':
              if (data.instructions !== undefined && typeof data.instructions !== 'string')
                throw new HttpError(400, 'Invalid instructions')
              json(202, {
                taskId: await conversation.compact(data.instructions, context),
              })
              break
          }
          return true
        }
        if (url.pathname === '/api/auth/login') {
          if (data.type !== 'api_key' && data.type !== 'oauth')
            throw new HttpError(400, 'Invalid auth type')
          const provider = text(data.provider, 'provider')
          const definition = host.modelRuntime.getProvider(provider)
          if (!definition?.auth[data.type === 'oauth' ? 'oauth' : 'apiKey']?.login)
            throw new HttpError(400, 'Unsupported provider or login type')
          json(202, { flowId: auth.login(provider, data.type) })
          return true
        }
        if (url.pathname === '/api/auth/logout') {
          await host.modelRuntime.logout(text(data.provider, 'provider'))
          json(200, { ok: true })
          return true
        }
        const flow = /^\/api\/auth\/flows\/([^/]+)\/(answer|cancel)$/.exec(url.pathname)
        if (flow) {
          const pending = auth.flows.get(flow[1])
          if (!pending) throw new HttpError(404, 'Unknown login flow')
          if (flow[2] === 'answer' && !pending.answer)
            throw new HttpError(409, 'No pending prompt for flow')
          if (flow[2] === 'answer') auth.answer(flow[1], text(data.value, 'value'))
          else auth.cancel(flow[1])
          json(200, { ok: true })
          return true
        }
        throw new HttpError(404, 'Unknown endpoint')
      } catch (error) {
        if (!response.headersSent)
          json(error instanceof HttpError ? error.status : 500, {
            error: error instanceof HttpError ? error.message : 'Request failed',
          })
        else response.destroy()
      }
      return true
    },
    async close() {
      closed = true
      auth.close()
      unsubscribe()
      unsubscribeGraph()
      clearTimeout(timer)
      await Promise.all([...streams].map((stop) => stop()))
      await refreshing
      graph.dispose()
    },
  }
}
