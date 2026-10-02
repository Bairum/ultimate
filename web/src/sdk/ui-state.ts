import type { JsonValue } from '@earendil-works/chord'
import type { UiUpdateRequest } from '../../../shared/protocol.ts'

/**
 * Durable UI state: the flat JSON map of the root conversation's `ultimate.ui` document, shared by every tab and
 * device, such as which conversation, panel, and view the shell shows. Writes apply locally at once, reach the server
 * coalesced (`POST /api/ui`), and stay overlaid until the stream confirms them.
 */
export type UiValues = Readonly<Record<string, JsonValue>>

/**
 * The newest local write of one key (`undefined` deletes it). `seq` orders writes: an acknowledgement only settles
 * the key when it carries the newest write, so a slower, older batch can never bring back a value written after it.
 */
interface LocalWrite {
  value: JsonValue | undefined
  seq: number
  /** `pending` until sent, `sent` until the server accepts it, then `acknowledged`. */
  state: 'pending' | 'sent' | 'acknowledged'
  /** The stream has shown this value since it was sent. */
  seen: boolean
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)

export function createUiState(
  write: (change: UiUpdateRequest) => Promise<unknown>,
  options: { delayMs?: number; settleMs?: number; onError?: (error: unknown) => void } = {},
) {
  const listeners = new Set<() => void>()
  let remote: UiValues = {}
  const local = new Map<string, LocalWrite>()
  let values: UiValues = {}
  let seq = 0
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
  /** Drop acknowledged writes the stream has shown: from then on the stream is the truth, other tabs included. */
  function settle() {
    for (const [key, entry] of local)
      if (entry.state === 'acknowledged' && entry.seen) local.delete(key)
  }
  /** Run `change` on the keys of a batch whose newest write is still the one the batch sent. */
  function current(
    batch: ReadonlyMap<string, number>,
    change: (key: string, entry: LocalWrite) => void,
  ) {
    for (const [key, sent] of batch) {
      const entry = local.get(key)
      if (entry?.seq === sent) change(key, entry)
    }
  }
  function flush() {
    timer = undefined
    const batch = new Map<string, number>()
    const change: UiUpdateRequest = { set: {}, delete: [] }
    for (const [key, entry] of local) {
      if (entry.state !== 'pending') continue
      entry.state = 'sent'
      batch.set(key, entry.seq)
      if (entry.value === undefined) change.delete?.push(key)
      else if (change.set) change.set[key] = entry.value
    }
    if (batch.size === 0) return
    write(change).then(
      () => {
        current(batch, (key, entry) => {
          entry.state = 'acknowledged'
          // The commit may already be on screen (it can arrive before this response).
          if (same(remote[key], entry.value)) entry.seen = true
        })
        settle()
        update()
        // The stream delivers the commit right away; never let an unconfirmed overlay hide later writes for long.
        setTimeout(() => {
          current(batch, (key, entry) => {
            if (entry.state === 'acknowledged') local.delete(key)
          })
          update()
        }, options.settleMs ?? 2000)
      },
      (error: unknown) => {
        current(batch, (key) => local.delete(key))
        update()
        options.onError?.(error)
      },
    )
  }
  function set(key: string, value: JsonValue | undefined) {
    if (same(values[key], value)) return
    local.set(key, { value, seq: ++seq, state: 'pending', seen: false })
    timer ??= setTimeout(flush, options.delayMs ?? 150)
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
      for (const [key, entry] of local)
        if (entry.state !== 'pending' && same(remote[key], entry.value)) entry.seen = true
      settle()
      update()
    },
    /** Send what is pending now, such as before the page goes away. */
    flush,
  }
}
export type UiState = ReturnType<typeof createUiState>
