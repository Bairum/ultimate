import type { Api } from './api.ts'
import type { Store } from './store.ts'

/** What `GET /api/whoami` says of this browser: `host` holds the pairing cookie, `user` may act as the user. */
export interface Whoami {
  user: boolean
  host: boolean
}

/** Pairing as the page knows it: whoami once read, and when a call last failed for want of pairing. */
export interface Pairing {
  whoami?: Whoami
  /** `Date.now()` of the latest call refused because this browser is not paired. */
  refusedAt?: number
}

/** The server's refusal (`pairingRequired` in server/request-security.ts), as the browser sees it. */
export const PAIRING_REQUIRED = 'Pair this browser with Ultimate to do this'

/** A page the browser tool drives (unpaired by design), read live so a test can lift it. */
export const driven = () => sessionStorage.getItem('ultimate.driven') === '1'
/** Whether `error` is a call refused because this browser is not paired. */
export const refusedForPairing = (error: unknown) =>
  error instanceof Error &&
  'status' in error &&
  error.status === 403 &&
  error.message === PAIRING_REQUIRED

/**
 * Whoami, read at start, when the tab comes back into view (a pairing tab of this browser profile pairs it too) and
 * when the stream opens again (a restart may be another server).
 */
export function createPairing(api: Pick<Api, 'whoami'>, store: Store) {
  let state: Pairing = {}
  const listeners = new Set<() => void>()
  const set = (next: Pairing) => {
    state = next
    for (const listener of listeners) listener()
  }
  let reading: Promise<void> | undefined
  /** Read whoami unless a read is in flight; it never rejects: unknown until the server answers again. */
  const refresh = (): void => {
    reading ??= api
      .whoami()
      .then((whoami) => set({ ...state, whoami }))
      .catch(() => {
        // Pairing stays as last read; the next focus or reconnect reads it again.
      })
      .finally(() => (reading = undefined))
  }
  let status = store.getState().connection.status
  store.subscribe(() => {
    const next = store.getState().connection.status
    if (next === status) return
    status = next
    if (next === 'open') refresh()
  })
  addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh()
  })
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    /** A call was refused for want of pairing: say so, and read whoami again (a cookie may have expired). */
    refused() {
      set({ ...state, refusedAt: Date.now() })
      refresh()
    },
  }
}
