import { projectBase } from './api.ts'
import { applyImmutable } from '@earendil-works/chord/delta'
import type { JsonValue } from '@earendil-works/chord'
import type { ConversationView, JsonObject, TaskGraph } from '@earendil-works/pi-durable'
import type {
  ConversationSummary,
  ModelsResponse,
  Notice,
  ServerEvents,
  SystemInfo,
} from '../../../shared/protocol.ts'

export interface Connection {
  /** `connecting` before the first open, `reconnecting` after a drop. */
  status: 'connecting' | 'open' | 'reconnecting'
  /** Epoch ms of the last status change. */
  since: number
}
/** Per-tab UI state; what should survive a reload lives in `uiState` (ui-state.ts). */
export interface UiState {
  paletteOpen: boolean
  dialogs: Readonly<Record<string, boolean | undefined>>
  theme: 'dark' | 'light'
  /** The surface on screen, which the host records as it renders: the shown one, or the next in line after it failed. */
  surface?: { id: string; title: string }
  /**
   * Whether the sidebar and the panel are open below desktop width, where they are this tab's own (viewport.ts), per
   * viewport: folding a phone shows the conversation, unfolding it brings back what docked beside it.
   */
  open?: Partial<Record<'phone' | 'tablet', { sidebar?: boolean; panels?: boolean }>>
}
/** A notice; one the browser raises can carry an action, and then stays until it is taken or dismissed. */
export interface BrowserNotice extends Notice {
  action?: { label: string; run: () => void }
}
type Docs = Readonly<Record<string, JsonObject | null>>
export interface State {
  connection: Connection
  /** The conversation the stream should show; the server's root when absent. */
  requested?: number
  /** The shown conversation's replica: snapshot plus every applied ops batch. */
  view?: ConversationView
  /** Extension documents of the shown conversation, by kind. */
  docs: Docs
  /** Extension documents of given conversations (`watchDocOf`), by conversation id, then kind. */
  docsOf: Readonly<Record<number, Docs>>
  /** The root conversation's `ultimate.ui` document, once streamed; read it through `uiState`. */
  shared?: Readonly<Record<string, JsonValue>>
  system?: SystemInfo & { offline?: boolean }
  conversations: readonly ConversationSummary[]
  tasks?: TaskGraph
  models?: ModelsResponse
  notices: readonly (BrowserNotice & { id: number; at: number })[]
  ui: UiState
}

/** The subset of `EventSource` the store uses, so tests can pass a fake. */
export interface EventSourceLike {
  readonly readyState: number
  addEventListener(name: string, listener: (event: Event) => void): void
  close(): void
}
export interface StoreOptions {
  /** Origin of the server; empty for same-origin. */
  base?: string
  eventSource?: (url: string) => EventSourceLike
  fetch?: typeof fetch
  /** Delay before reopening a stream the server closed. */
  retryMs?: number
  /** Called when the requested conversation could not be opened and the stream fell back to the root. */
  onFallback?: () => void
  ui?: Partial<UiState>
}

const CLOSED = 2
const names = [
  'system',
  'conversations',
  'view',
  'ops',
  'ui',
  'uiOps',
  'doc',
  'docOps',
  'tasks',
  'notice',
] as const satisfies readonly (keyof ServerEvents)[]

/** A stream of documents of one conversation (`watchDocOf`): its sorted, comma-joined kinds. */
interface DocStream {
  kinds: string
  source: EventSourceLike
  retry?: ReturnType<typeof setTimeout>
}

/**
 * `docs` after a `doc` snapshot or `docOps` batch. Ops need their stream's snapshot: a kind without one, such as a kind
 * watched again, waits for the reconnect that brings it.
 */
function applyDoc(docs: Docs, event: ServerEvents['doc'] | ServerEvents['docOps']): Docs {
  if ('value' in event) return { ...docs, [event.kind]: event.value }
  const current = docs[event.kind]
  if (current === undefined) return docs
  return { ...docs, [event.kind]: applyImmutable(current ?? {}, event.ops) }
}

export function createStore(options: StoreOptions = {}) {
  const base = options.base ?? projectBase()
  const open = options.eventSource ?? ((url: string) => new EventSource(url))
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  let state: State = {
    connection: { status: 'connecting', since: Date.now() },
    docs: {},
    docsOf: {},
    conversations: [],
    notices: [],
    ui: {
      paletteOpen: false,
      dialogs: {},
      theme: 'dark',
      ...options.ui,
    },
  }
  const listeners = new Set<() => void>()
  const docKinds = new Map<string, number>()
  /** Watch counts of documents of given conversations, by conversation id, then kind. */
  const watchedOf = new Map<number, Map<string, number>>()
  /** One stream per conversation in `watchedOf`, carrying all its watched kinds. */
  const docStreams = new Map<number, DocStream>()
  let source: EventSourceLike | undefined
  let opened = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let sync: ReturnType<typeof setTimeout> | undefined
  let noticeId = 0
  let offlineNoticeShown = false
  /** The cloud deploy this page was loaded from; a local server names none. */
  let version: string | undefined
  let updateNoticeShown = false
  /** The stream dropped since the last `system` event, so the next one belongs to a reopened stream. */
  let reconnected = false
  let stopped = true

  function set(change: Partial<State>) {
    state = { ...state, ...change }
    for (const listener of listeners) listener()
  }
  function setConnection(status: Connection['status']) {
    if (state.connection.status !== status) set({ connection: { status, since: Date.now() } })
  }

  function handle(name: keyof ServerEvents, data: unknown) {
    switch (name) {
      case 'system': {
        const system = data as NonNullable<State['system']>
        if (!system.offline) offlineNoticeShown = false
        const restarted =
          state.system &&
          (state.system.process.pid !== system.process.pid ||
            state.system.process.generation !== system.process.generation)
        set({ system })
        // A reopened stream may follow a cloud deploy: the models response carries its version (`received`).
        if (!state.models || restarted || reconnected) void refreshModels()
        reconnected = false
        break
      }
      case 'conversations':
        set({ conversations: data as ServerEvents['conversations'] })
        break
      case 'view':
        // A (re)connect starts from a fresh snapshot; ops of the old stream are gone with it.
        set({ view: data as ConversationView })
        break
      case 'ops':
        if (state.view) set({ view: applyImmutable(state.view, data as ServerEvents['ops']) })
        break
      case 'ui':
        set({ shared: (data as ServerEvents['ui']).value })
        break
      case 'uiOps':
        if (state.shared)
          set({ shared: applyImmutable(state.shared, (data as ServerEvents['uiOps']).ops) })
        break
      case 'doc':
      case 'docOps': {
        const event = data as ServerEvents['doc'] | ServerEvents['docOps']
        if (!docKinds.has(event.kind)) break
        const docs = applyDoc(state.docs, event)
        if (docs !== state.docs) set({ docs })
        break
      }
      case 'tasks':
        set({ tasks: data as TaskGraph })
        break
      case 'notice':
        // The replica sends its offline notice with every SSE snapshot. Facet subscriptions reopen the stream;
        // show that notice once per offline transition, not again for each subscription or conversation switch.
        if (state.system?.offline) {
          if (offlineNoticeShown) break
          offlineNoticeShown = true
        }
        addNotice(data as BrowserNotice)
        break
    }
  }
  function addNotice(notice: BrowserNotice) {
    set({ notices: [...state.notices.slice(-49), { ...notice, id: ++noticeId, at: Date.now() }] })
  }

  function connect() {
    clearTimeout(retry)
    source?.close()
    const params = new URLSearchParams()
    if (state.requested !== undefined) params.set('conversation', String(state.requested))
    const kinds = [...docKinds.keys()].toSorted()
    if (kinds.length) params.set('docs', kinds.join(','))
    const query = params.size ? `?${params}` : ''
    const current = open(`${base}/api/events${query}`)
    source = current
    opened = false
    current.addEventListener('open', () => {
      if (source !== current) return
      opened = true
      setConnection('open')
    })
    current.addEventListener('error', () => {
      if (source !== current) return
      reconnected = true
      setConnection(opened || state.view ? 'reconnecting' : 'connecting')
      // EventSource retries by itself unless the server answered with an error status.
      if (current.readyState === CLOSED) {
        // A conversation that never opened is likely gone (a new home): fall back to the root.
        if (!opened && state.requested !== undefined && !state.view) {
          set({ requested: undefined })
          options.onFallback?.()
        }
        retry = setTimeout(connect, options.retryMs ?? 1000)
      }
    })
    for (const name of names)
      current.addEventListener(name, (event) => {
        if (source === current) handle(name, JSON.parse((event as MessageEvent<string>).data))
      })
  }
  function scheduleReconnect() {
    if (stopped) return
    clearTimeout(reconnect)
    reconnect = setTimeout(connect, 0)
  }

  function openDocs(conversation: number, kinds: string) {
    closeDocs(conversation)
    const params = new URLSearchParams({ conversation: String(conversation), docs: kinds })
    const stream: DocStream = { kinds, source: open(`${base}/api/events?${params}`) }
    docStreams.set(conversation, stream)
    stream.source.addEventListener('error', () => {
      // EventSource retries by itself unless the server answered with an error status.
      if (docStreams.get(conversation) === stream && stream.source.readyState === CLOSED)
        stream.retry = setTimeout(() => openDocs(conversation, kinds), options.retryMs ?? 1000)
    })
    for (const name of ['doc', 'docOps'] as const)
      stream.source.addEventListener(name, (event) => {
        if (docStreams.get(conversation) !== stream) return
        const docs = state.docsOf[conversation] ?? {}
        const next = applyDoc(docs, JSON.parse((event as MessageEvent<string>).data))
        if (next !== docs) set({ docsOf: { ...state.docsOf, [conversation]: next } })
      })
  }
  function closeDocs(conversation: number) {
    const stream = docStreams.get(conversation)
    stream?.source.close()
    clearTimeout(stream?.retry)
    docStreams.delete(conversation)
  }
  /** Give each watched conversation one stream of exactly its watched kinds, and close the rest. */
  function syncDocs() {
    for (const conversation of docStreams.keys())
      if (!watchedOf.has(conversation)) closeDocs(conversation)
    const docsOf: Record<number, Docs> = {}
    for (const [conversation, kinds] of watchedOf) {
      const list = [...kinds.keys()].toSorted().join(',')
      if (docStreams.get(conversation)?.kinds !== list) openDocs(conversation, list)
      // Kinds nobody watches anymore go; the rest keep their value until the new stream's snapshot replaces it.
      docsOf[conversation] = Object.fromEntries(
        Object.entries(state.docsOf[conversation] ?? {}).filter(([kind]) => kinds.has(kind)),
      )
    }
    set({ docsOf })
  }
  function scheduleSync() {
    if (stopped) return
    clearTimeout(sync)
    sync = setTimeout(syncDocs, 0)
  }

  async function refreshModels() {
    try {
      const response = await request(`${base}/api/models`)
      received(response)
      if (response.ok) set({ models: (await response.json()) as ModelsResponse })
    } catch {
      // The next system event retries.
    }
  }

  /**
   * Note the cloud deploy that answered: the Worker names it in `x-ultimate-cloud-version`. Once it differs from the
   * first one seen, this page runs an old UI against a new Worker, so offer one reload. Drafts stay in the browser.
   */
  function received(response: Response) {
    const next = response.headers.get('x-ultimate-cloud-version')
    if (!next) return
    version ??= next
    if (next === version || updateNoticeShown) return
    updateNoticeShown = true
    addNotice({
      level: 'info',
      message: 'Ultimate was updated',
      action: { label: 'Reload', run: () => location.reload() },
    })
  }

  return {
    getState: () => state,
    received,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (!stopped) return
      stopped = false
      connect()
      syncDocs()
    },
    stop() {
      stopped = true
      clearTimeout(retry)
      clearTimeout(reconnect)
      clearTimeout(sync)
      source?.close()
      source = undefined
      for (const conversation of docStreams.keys()) closeDocs(conversation)
    },
    /** Show another conversation: its replica replaces the current one. */
    show(id: number | undefined) {
      if (id === state.requested) return
      set({ requested: id, view: undefined, docs: {} })
      scheduleReconnect()
    },
    /** Stream an extension document of the shown conversation until the returned release runs. */
    watchDoc(kind: string) {
      const count = docKinds.get(kind) ?? 0
      docKinds.set(kind, count + 1)
      if (count === 0) scheduleReconnect()
      return () => {
        const left = (docKinds.get(kind) ?? 1) - 1
        if (left > 0) docKinds.set(kind, left)
        else {
          docKinds.delete(kind)
          const { [kind]: _removed, ...docs } = state.docs
          set({ docs })
        }
      }
    },
    /**
     * Stream an extension document of conversation `conversation`, shown or not, until the returned release runs.
     * Watches of one conversation share a stream.
     */
    watchDocOf(conversation: number, kind: string) {
      const kinds = watchedOf.get(conversation) ?? new Map<string, number>()
      watchedOf.set(conversation, kinds)
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      scheduleSync()
      return () => {
        const left = (kinds.get(kind) ?? 1) - 1
        if (left > 0) kinds.set(kind, left)
        else kinds.delete(kind)
        if (!kinds.size) watchedOf.delete(conversation)
        scheduleSync()
      }
    },
    refreshModels,
    setUi(change: Partial<UiState>) {
      set({ ui: { ...state.ui, ...change } })
    },
    /** Add a notice from the browser, such as a failed command. */
    notify(notice: BrowserNotice) {
      handle('notice', notice)
    },
    dismissNotice(id: number) {
      set({ notices: state.notices.filter((notice) => notice.id !== id) })
    },
  }
}
export type Store = ReturnType<typeof createStore>
