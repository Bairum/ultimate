import type { JsonValue } from '@earendil-works/chord'
import type { UiUpdateRequest } from '../../../shared/protocol.ts'

/**
 * Durable UI state: the flat JSON map of the root conversation's `ultimate.ui` document, shared by every tab and
 * device, such as which conversation, panel, and view the shell shows. Writes apply locally at once, reach the server
 * coalesced (`POST /api/ui`), and stay overlaid until the stream confirms them.
 */
export type UiValues = Readonly<Record<string, JsonValue>>

/** A key's pending value; `undefined` deletes it. */
type Overlay = Map<string, JsonValue | undefined>

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)

export function createUiState(
  write: (change: UiUpdateRequest) => Promise<unknown>,
  options: { delayMs?: number; onError?: (error: unknown) => void } = {},
) {
  const listeners = new Set<() => void>()
  let remote: UiValues = {}
  /** Writes not sent yet, and sent batches the stream has not confirmed. */
  let pending: Overlay = new Map()
  const sent: { overlay: Overlay; acknowledged: boolean }[] = []
  let values: UiValues = {}
  let timer: ReturnType<typeof setTimeout> | undefined

  function update() {
    const next: Record<string, JsonValue> = { ...remote }
    for (const overlay of [...sent.map((batch) => batch.overlay), pending])
      for (const [key, value] of overlay) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
    values = next
    for (const listener of listeners) listener()
  }
  /** Drop acknowledged batches once the stream shows what they wrote. */
  function settle() {
    for (const batch of sent.filter((candidate) => candidate.acknowledged))
      if ([...batch.overlay].every(([key, value]) => same(remote[key], value)))
        sent.splice(sent.indexOf(batch), 1)
  }
  function flush() {
    timer = undefined
    if (pending.size === 0) return
    const batch = { overlay: pending, acknowledged: false }
    pending = new Map()
    sent.push(batch)
    const change: UiUpdateRequest = { set: {}, delete: [] }
    for (const [key, value] of batch.overlay)
      if (value === undefined) change.delete?.push(key)
      else if (change.set) change.set[key] = value
    write(change).then(
      () => {
        batch.acknowledged = true
        settle()
        update()
        // The stream delivers the commit right away; never let a stale overlay hide a later write.
        setTimeout(() => {
          const index = sent.indexOf(batch)
          if (index < 0) return
          sent.splice(index, 1)
          update()
        }, 2000)
      },
      (error: unknown) => {
        sent.splice(sent.indexOf(batch), 1)
        update()
        options.onError?.(error)
      },
    )
  }
  function set(key: string, value: JsonValue | undefined) {
    if (same(values[key], value)) return
    pending.set(key, value)
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
      settle()
      update()
    },
    /** Send what is pending now, such as before the page goes away. */
    flush,
  }
}
export type UiState = ReturnType<typeof createUiState>
