import { createApi } from './api.ts'
import { createRegistry } from './registry.ts'
import { createStore } from './store.ts'
import { createUiState } from './ui-state.ts'

/** The page's one live stream and its replica. */
export const store = createStore({
  ui: { theme: localStorage.getItem('ultimate.theme') === 'light' ? 'light' : 'dark' },
  onFallback: () => uiState.delete('shell.conversation'),
})
/** Server commands; conversation commands default to the shown conversation. */
export const api = createApi(store)
/** Durable UI state shared by every tab, fed by the stream (see ui-state.ts). */
export const uiState = createUiState(api.updateUi, {
  onError: (error) =>
    store.notify({ level: 'error', message: `UI state not saved: ${String(error)}` }),
})
/** Installed web facets of `extensions/*`. */
export const registry = createRegistry()

store.subscribe(() => {
  const { shared, ui } = store.getState()
  if (shared) uiState.receive(shared)
  // The theme is a preference of this browser.
  localStorage.setItem('ultimate.theme', ui.theme)
  document.documentElement.classList.toggle('dark', ui.theme === 'dark')
})
// The stream follows `shell.conversation`, whichever tab or action set it.
uiState.subscribe(() => {
  const id = uiState.get('shell.conversation')
  store.show(typeof id === 'number' ? id : undefined)
})
addEventListener('pagehide', () => uiState.flush())

// These singletons own the live stream: a change to them reloads the page rather than run a second copy. The new
// module only constructs (nothing connects before `start()`), then the page reloads.
import.meta.hot?.accept(() => location.reload())
