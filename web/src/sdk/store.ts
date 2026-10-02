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
}
export interface State {
  connection: Connection
  /** The conversation the stream should show; the server's root when absent. */
  requested?: number
  /** The shown conversation's replica: snapshot plus every applied ops batch. */
  view?: ConversationView
  /** Extension documents of the shown conversation, by kind. */
  docs: Readonly<Record<string, JsonObject | null>>
  /** The root conversation's `ultimate.ui` document, once streamed; read it through `uiState`. */
  shared?: Readonly<Record<string, JsonValue>>
  system?: SystemInfo
  conversations: readonly ConversationSummary[]
  tasks?: TaskGraph
  models?: ModelsResponse
  notices: readonly (Notice & { id: number; at: number })[]
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

export function createStore(options: StoreOptions = {}) {
  const base = options.base ?? ''
  const open = options.eventSource ?? ((url: string) => new EventSource(url))
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  let state: State = {
    connection: { status: 'connecting', since: Date.now() },
    docs: {},
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
  let source: EventSourceLike | undefined
  let opened = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let noticeId = 0
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
        const system = data as SystemInfo
        const restarted =
          state.system &&
          (state.system.process.pid !== system.process.pid ||
            state.system.process.generation !== system.process.generation)
        set({ system })
        if (!state.models || restarted) void refreshModels()
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
      case 'doc': {
        const { kind, value } = data as ServerEvents['doc']
        if (!docKinds.has(kind)) break
        set({ docs: { ...state.docs, [kind]: value } })
        break
      }
      case 'docOps': {
        const { kind, ops } = data as ServerEvents['docOps']
        // Ops need this stream's snapshot: a kind watched again waits for the reconnect that brings one.
        if (!docKinds.has(kind) || state.docs[kind] === undefined) break
        set({ docs: { ...state.docs, [kind]: applyImmutable(state.docs[kind] ?? {}, ops) } })
        break
      }
      case 'tasks':
        set({ tasks: data as TaskGraph })
        break
      case 'notice':
        set({
          notices: [
            ...state.notices.slice(-49),
            { ...(data as Notice), id: ++noticeId, at: Date.now() },
          ],
        })
        break
    }
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

  async function refreshModels() {
    try {
      const response = await request(`${base}/api/models`)
      if (response.ok) set({ models: (await response.json()) as ModelsResponse })
    } catch {
      // The next system event retries.
    }
  }

  return {
    getState: () => state,
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
    },
    stop() {
      stopped = true
      clearTimeout(retry)
      clearTimeout(reconnect)
      source?.close()
      source = undefined
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
    refreshModels,
    setUi(change: Partial<UiState>) {
      set({ ui: { ...state.ui, ...change } })
    },
    /** Add a notice from the browser, such as a failed command. */
    notify(notice: Notice) {
      handle('notice', notice)
    },
    dismissNotice(id: number) {
      set({ notices: state.notices.filter((notice) => notice.id !== id) })
    },
  }
}
export type Store = ReturnType<typeof createStore>
