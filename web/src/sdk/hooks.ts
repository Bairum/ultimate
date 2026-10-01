import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { JsonValue } from '@earendil-works/chord'
import type {
  AgentState,
  ConversationView,
  EntryRecord,
  InboxItem,
  JsonObject,
  LiveState,
  UsageState,
} from '@earendil-works/pi-durable'
import { actions, allCommands } from './actions.ts'
import { registry, store, uiState } from './client.ts'
import type { State } from './store.ts'
import { formatDuration } from './format.ts'
import type { ToolCallView, UltimateContext } from './types.ts'

/** Read a slice of the client state; re-renders when the selected value changes identity. */
export function useStore<T>(select: (state: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}

export interface ConversationState {
  /** The shown conversation, once its snapshot arrived. */
  id?: number
  /** True until the snapshot of the shown conversation arrived. */
  loading: boolean
  /** Active transcript entries, oldest first. */
  entries: readonly EntryRecord[]
  /** `pi.agent`: model, thinking level, cwd, extensions, tools. */
  agent: AgentState
  /** `pi.usage`: spend per model and per tool. */
  usage: UsageState
  /** `pi.live`: the run, the streaming partial, running tools, retries, compactions. */
  live: LiveState
  /** `pi.inbox`: queued steers, follow-ups, and writes. */
  inbox: readonly InboxItem[]
  /** A run is in progress. */
  busy: boolean
  view?: ConversationView
}

const empty: ConversationState = {
  loading: true,
  entries: [],
  agent: {},
  usage: { models: {}, tools: {} },
  live: {},
  inbox: [],
  busy: false,
}
const derived = new WeakMap<ConversationView, ConversationState>()
function derive(view: ConversationView | undefined): ConversationState {
  if (!view) return empty
  let state = derived.get(view)
  if (!state) {
    const docs = view.docs as Readonly<Record<string, JsonObject | undefined>>
    const live = (docs['pi.live'] ?? {}) as LiveState
    state = {
      id: view.conversation.id,
      loading: false,
      entries: view.entries,
      agent: docs['pi.agent'] ?? {},
      usage: (docs['pi.usage'] ?? empty.usage) as UsageState,
      live,
      inbox: (docs['pi.inbox'] as { items?: InboxItem[] } | undefined)?.items ?? [],
      busy: !!live.run,
      view,
    }
    derived.set(view, state)
  }
  return state
}

/** The shown conversation's replica. */
export function useConversation(): ConversationState {
  return derive(useStore((state) => state.view))
}
export const useSystem = () => useStore((state) => state.system)
export const useConversations = () => useStore((state) => state.conversations)
/** The live task graph of every conversation. */
export const useTasks = () => useStore((state) => state.tasks)
/** `GET /api/models`, refreshed after (re)connects and logins. */
export const useModels = () => useStore((state) => state.models)
export const useAuthFlows = () => useStore((state) => state.authFlows)
export const useNotices = () => useStore((state) => state.notices)
/** Stream state: connecting, open, or reconnecting. */
export const useConnection = () => useStore((state) => state.connection)

/** An extension document of the shown conversation (`export const docs` of a server facet); null until created. */
export function useDoc<T extends JsonObject = JsonObject>(
  kind: string,
): Readonly<T> | null | undefined {
  useEffect(() => store.watchDoc(kind), [kind])
  return useStore((state) => state.docs[kind]) as Readonly<T> | null | undefined
}

/** The shown conversation id and the shell's actions. */
export function useUltimate(): UltimateContext {
  const conversationId = useStore((state) => state.view?.conversation.id)
  return useMemo(() => ({ ...actions, conversationId }), [conversationId])
}

/**
 * Durable UI state under `key`, stored with the main conversation (`ultimate.ui`): it survives reloads and restarts
 * and is shared by every tab, so the UI resumes where it was. Values are JSON; keys use `[A-Za-z0-9_.:-]`. The setter
 * takes a value or an updater and applies at once.
 */
export function useUiState<T extends JsonValue>(
  key: string,
  initial: T,
): [Widen<T>, (next: Widen<T> | ((previous: Widen<T>) => Widen<T>)) => void] {
  const stored = useSyncExternalStore(uiState.subscribe, () => uiState.get(key))
  const fallback = useRef(initial)
  fallback.current = initial
  const set = useCallback(
    (next: Widen<T> | ((previous: Widen<T>) => Widen<T>)) => {
      const previous = (uiState.get(key) ?? fallback.current) as Widen<T>
      uiState.set(key, typeof next === 'function' ? next(previous) : next)
    },
    [key],
  )
  return [(stored ?? initial) as Widen<T>, set]
}
/** `true` → boolean, `'a'` → string: an initial value names its type, not the only value. */
export type Widen<T> = T extends boolean
  ? boolean
  : T extends string
    ? string
    : T extends number
      ? number
      : T

/** The extension whose contribution is rendering; the shell provides it. */
export const ExtensionNameContext = createContext<string | undefined>(undefined)

/** `useUiState` under `ext.<extension name>.<key>`, for state an extension's UI keeps across reloads. */
export function useExtensionUiState<T extends JsonValue>(
  key: string,
  initial: T,
): [Widen<T>, (next: Widen<T> | ((previous: Widen<T>) => Widen<T>)) => void] {
  const extension = useContext(ExtensionNameContext)
  if (!extension) throw new Error('useExtensionUiState works inside an extension contribution only')
  return useUiState(`ext.${extension}.${key}`, initial)
}

/** Whether dialog `id` is open, and a setter; `useUltimate().open(id)` opens it from anywhere. */
export function useDialog(id: string): [boolean, (open: boolean) => void] {
  const open = useStore((state) => state.ui.dialogs[id] === true)
  return [open, (next: boolean) => (next ? actions.open(id) : actions.close(id))]
}

/** Installed web facets, in folder order. */
export function useExtensions() {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot)
}
/** Core and extension commands. */
export function useCommands() {
  const records = useExtensions()
  return useMemo(() => allCommands(), [records])
}

/** The current time, updated every `intervalMs` while `active`. */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, active])
  return now
}

/** Wall time of a tool call this page saw running, ticking while it runs; undefined for calls finished before load. */
export function useToolDuration(call: ToolCallView): string | undefined {
  const running = call.startedAt !== undefined && call.endedAt === undefined
  const now = useNow(100, running)
  if (call.startedAt === undefined) return undefined
  return formatDuration((call.endedAt ?? now) - call.startedAt)
}
