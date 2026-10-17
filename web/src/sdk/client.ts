import { ActionError, actionMessage, createApi, MachineOfflineError } from './api.ts'
import { createRegistry } from './registry.ts'
import { createStore } from './store.ts'
import { createUiState } from './ui-state.ts'

const initialUrl = new URL(location.href)
let initialized = false
let replaceSelection = true
let selected: number | undefined

function urlConversation() {
  const value = new URL(location.href).searchParams.get('conversation')
  const id = value && /^\d+$/.test(value) ? Number(value) : undefined
  return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined
}
function writeConversation(id: number, replace: boolean) {
  const url = new URL(location.href)
  if (url.searchParams.get('conversation') === String(id)) return
  url.searchParams.set('conversation', String(id))
  if (replace) history.replaceState(history.state, '', url)
  else history.pushState(history.state, '', url)
}

/** The page's one live stream and its replica. */
export const store = createStore({
  ui: { theme: localStorage.getItem('ultimate.theme') === 'light' ? 'light' : 'dark' },
  onFallback: () => {
    replaceSelection = true
    uiState.delete('shell.conversation')
  },
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
  const { shared, ui, system } = store.getState()
  if (system && !registry.getReady().ready) registry.receiveSystem()
  if (shared) {
    if (!initialized) {
      // Receive the saved shell first, but do not follow it until the explicit URL has won.
      uiState.receive(shared)
      if (initialUrl.searchParams.has('conversation')) {
        const id = urlConversation()
        if (id === undefined) uiState.delete('shell.conversation')
        else uiState.set('shell.conversation', id)
      }
      initialized = true
      followSelection()
    } else uiState.receive(shared)
  }
  const { view, requested } = store.getState()
  if (initialized && view && (requested === undefined || requested === view.conversation.id)) {
    writeConversation(view.conversation.id, true)
    replaceSelection = false
  }
  // The theme is a preference of this browser.
  localStorage.setItem('ultimate.theme', ui.theme)
  document.documentElement.classList.toggle('dark', ui.theme === 'dark')
})
/** The next selection replaces the current history entry rather than pushing one, as a redirect does. */
export function replaceNextSelection() {
  replaceSelection = true
}
// The stream follows `shell.conversation`, whichever tab or action set it.
function followSelection() {
  if (!initialized) return
  const value = uiState.get('shell.conversation')
  const id = typeof value === 'number' ? value : undefined
  if (id !== selected) {
    selected = id
    if (id !== undefined) writeConversation(id, replaceSelection)
  }
  store.show(id)
  replaceSelection = false
}
uiState.subscribe(followSelection)
addEventListener('popstate', () => {
  replaceSelection = true
  const id = urlConversation()
  if (id === undefined) uiState.delete('shell.conversation')
  else uiState.set('shell.conversation', id)
  // An unchanged selection emits no notification, but may still need URL canonicalization.
  followSelection()
  const { view, requested } = store.getState()
  if (view && (requested === undefined || requested === view.conversation.id)) {
    writeConversation(view.conversation.id, true)
    replaceSelection = false
  }
})
addEventListener('pagehide', () => uiState.flush())
// An action failure no caller handled: show it rather than lose it in the console.
addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof MachineOfflineError) {
    event.preventDefault()
    store.notify({ level: 'warning', message: event.reason.message })
    return
  }
  if (!(event.reason instanceof ActionError)) return
  event.preventDefault()
  store.notify({ level: 'error', message: actionMessage(event.reason) })
})

// These singletons own the live stream: a change to them reloads the page rather than run a second copy. The new
// module only constructs (nothing connects before `start()`), then the page reloads.
import.meta.hot?.accept(() => location.reload())
