import { api, registry, store, uiState } from './client.ts'
import { commandItems, panelItems, slotItems, viewItems } from './registry.ts'
import type { CommandItem } from './registry.ts'
import type { CommandContribution, UltimateActions, UltimateContext } from './types.ts'

/** Shell state that survives reloads and follows across tabs (see ui-state.ts). */
export const shellKeys = {
  conversation: 'shell.conversation',
  panel: 'shell.panel',
  panelOpen: 'shell.panelOpen',
  sidebarOpen: 'shell.sidebarOpen',
  view: 'shell.view',
  dockOpen: 'shell.dockOpen',
} as const

const flag = (key: string, fallback: boolean) => {
  const value = uiState.get(key)
  return typeof value === 'boolean' ? value : fallback
}

export const actions: UltimateActions = {
  switchConversation: (id) => uiState.set(shellKeys.conversation, id),
  openView: (id) => {
    if (id) uiState.set(shellKeys.view, id)
    else uiState.delete(shellKeys.view)
  },
  openPanel: (id) => {
    uiState.set(shellKeys.panelOpen, true)
    if (id) uiState.set(shellKeys.panel, id)
  },
  closePanel: () => uiState.set(shellKeys.panelOpen, false),
  togglePanel: () => uiState.set(shellKeys.panelOpen, !flag(shellKeys.panelOpen, false)),
  toggleSidebar: () => uiState.set(shellKeys.sidebarOpen, !flag(shellKeys.sidebarOpen, true)),
  runCommand: (id) => {
    const command = allCommands().find((candidate) => candidate.id === id)
    if (!command) return
    const context = currentContext()
    if (command.when && !command.when(context)) return
    void Promise.resolve()
      .then(() => command.run(context))
      .catch((error: unknown) =>
        store.notify({ level: 'error', message: `${command.title}: ${String(error)}` }),
      )
  },
  open: (dialog) => store.setUi({ dialogs: { ...store.getState().ui.dialogs, [dialog]: true } }),
  close: (dialog) => store.setUi({ dialogs: { ...store.getState().ui.dialogs, [dialog]: false } }),
  openPalette: () => store.setUi({ paletteOpen: true }),
  focusComposer: () => document.getElementById('composer-input')?.focus(),
}

export function currentContext(): UltimateContext {
  return { ...actions, conversationId: store.getState().view?.conversation.id }
}

const busy = () => !!store.getState().view?.docs['pi.live']?.run

/** The shell's own commands, listed with extension commands in the palette. */
const core: CommandContribution[] = [
  {
    id: 'ultimate.palette',
    title: 'Command palette',
    keys: 'mod+k',
    run: (context) => context.openPalette(),
  },
  {
    id: 'ultimate.abort',
    title: 'Stop the run',
    keys: 'escape',
    when: busy,
    run: () => api.abort(),
  },
  {
    id: 'ultimate.compact',
    title: 'Compact the context',
    run: () => api.compact(),
  },
  {
    id: 'ultimate.composer',
    title: 'Focus the composer',
    run: (context) => context.focusComposer(),
  },
  {
    id: 'ultimate.root',
    title: 'Show the main conversation',
    when: (context) => context.conversationId !== 1,
    run: (context) => context.switchConversation(1),
  },
  {
    id: 'ultimate.panel',
    title: 'Toggle the right panel',
    keys: 'mod+alt+b',
    when: () => panelItems(registry.getSnapshot()).length > 0,
    run: (context) => context.togglePanel(),
  },
  {
    id: 'ultimate.sidebar',
    title: 'Toggle the sidebar',
    keys: 'mod+b',
    when: () => slotItems(registry.getSnapshot(), 'sidebar').length > 0,
    run: (context) => context.toggleSidebar(),
  },
  {
    id: 'ultimate.theme',
    title: 'Toggle light and dark theme',
    run: () => store.setUi({ theme: store.getState().ui.theme === 'dark' ? 'light' : 'dark' }),
  },
]
export const coreCommands: CommandItem[] = core.map((command) => ({
  ...command,
  group: 'Ultimate',
  extension: 'core',
}))

/** Core commands, a command per view, and extension commands. */
export function allCommands(): CommandItem[] {
  const records = registry.getSnapshot()
  const views = viewItems(records)
  const shown = () => uiState.get(shellKeys.view)
  return [
    ...coreCommands,
    ...(views.length
      ? [
          {
            id: 'ultimate.view.conversation',
            title: 'Show the conversation',
            group: 'Views',
            extension: 'core',
            when: () => shown() !== undefined,
            run: () => actions.openView(undefined),
          },
        ]
      : []),
    ...views.map((view) => ({
      id: `ultimate.view.${view.id}`,
      title: `Show ${view.title}`,
      group: 'Views',
      extension: view.extension,
      when: () => shown() !== view.id,
      run: () => actions.openView(view.id),
    })),
    ...commandItems(records),
  ]
}
