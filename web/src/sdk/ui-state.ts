import type { JsonValue } from '@earendil-works/chord'
import type { UiUpdateRequest } from '../../../shared/protocol.ts'
import { MachineOfflineError } from './api.ts'

/**
 * Durable UI state: the flat JSON map of the root conversation's `ultimate.ui` document, shared by every tab and
 * device, such as which conversation, panel, and view the shell shows. Writes apply locally at once, reach the server
 * coalesced (`POST /api/ui`), and stay overlaid until the stream shows the commit that carried them.
 */
export type UiValues = Readonly<Record<string, JsonValue>>

/**
 * Each batch also writes `<tab>:<batch>` here, in the same commit. The stream delivers commits in order, so once it
 * shows this tab's marker for batch n, every write of batches up to n is in the stream's values: writes are confirmed
 * by identity, never by a value that happens to be equal (A → B → A).
 */
export const WRITE_MARKER = 'ui.write'

/** The newest local write of one key (`undefined` deletes it), and the batch that sent it, once sent. */
interface LocalWrite {
  value: JsonValue | undefined
  batch?: number
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)

export function createUiState(
  write: (change: UiUpdateRequest) => Promise<unknown>,
  options: {
    delayMs?: number
    settleMs?: number
    onError?: (error: unknown) => void
    /** This tab's id in the write marker; random by default. */
    tab?: string
  } = {},
) {
  const tab = options.tab ?? Math.random().toString(36).slice(2, 10)
  const listeners = new Set<() => void>()
  let remote: UiValues = {}
  const local = new Map<string, LocalWrite>()
  let values: UiValues = {}
  /** The last batch sent, and the newest one the stream has shown. */
  let sent = 0
  let shown = 0
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function update() {
    const next: Record<string, JsonValue> = { ...remote }
    for (const [key, { value }] of local) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    values = next
    for (const listener of listeners) listener()
  }
  /** Drop the overlay of writes from batches up to `batch`: the stream is the truth for them now. */
  function release(batch: number) {
    for (const [key, entry] of local)
      if (entry.batch !== undefined && entry.batch <= batch) local.delete(key)
  }
  function schedule(delay: number) {
    timer ??= setTimeout(() => {
      timer = undefined
      send(false)
    }, delay)
  }
  /**
   * Send what is pending as one batch. One batch is in flight at a time, so the server commits them in write order;
   * `force` sends anyway, for a page that is going away.
   */
  function send(force: boolean) {
    if (inFlight && !force) return
    const change: UiUpdateRequest = { set: {}, delete: [] }
    const batch = sent + 1
    let count = 0
    for (const [key, entry] of local) {
      if (entry.batch !== undefined) continue
      entry.batch = batch
      count++
      if (entry.value === undefined) change.delete?.push(key)
      else if (change.set) change.set[key] = entry.value
    }
    if (count === 0) return
    sent = batch
    if (change.set) change.set[WRITE_MARKER] = `${tab}:${batch}`
    inFlight = true
    const settled = () => {
      inFlight = false
      if ([...local.values()].some((entry) => entry.batch === undefined)) schedule(0)
    }
    write(change).then(
      () => {
        settled()
        // The stream normally shows the commit at once. If it never names this batch (a reconnect, or another tab's
        // commit in the same frame), let go after a while so later writes from elsewhere show through.
        setTimeout(() => {
          release(batch)
          update()
        }, options.settleMs ?? 2000)
      },
      (error: unknown) => {
        if (error instanceof MachineOfflineError) {
          // Keep replica browsing choices in this tab. They were not persisted, so neither an acknowledgement
          // nor the normal successful-write timeout should roll them back to the last synced selection.
          settled()
          return
        }
        for (const [key, entry] of local) if (entry.batch === batch) local.delete(key)
        settled()
        update()
        options.onError?.(error)
      },
    )
  }
  function set(key: string, value: JsonValue | undefined) {
    if (same(values[key], value)) return
    local.set(key, { value })
    schedule(options.delayMs ?? 150)
    update()
  }

  return {
    get: (key: string): JsonValue | undefined => values[key],
    snapshot: (): UiValues => values,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (key: string, value: JsonValue) => set(key, value),
    delete: (key: string) => set(key, undefined),
    /** The document as the stream last delivered it. */
    receive(next: UiValues) {
      if (next === remote) return
      remote = next
      const marker = remote[WRITE_MARKER]
      if (typeof marker === 'string' && marker.startsWith(`${tab}:`))
        shown = Math.max(shown, Number(marker.slice(tab.length + 1)) || 0)
      release(shown)
      update()
    },
    /** Send what is pending now, such as before the page goes away. */
    flush: () => {
      clearTimeout(timer)
      timer = undefined
      send(true)
    },
  }
}
export type UiState = ReturnType<typeof createUiState>
