import { registry, store, uiState } from './client.ts'
import {
  HOME,
  commandApplies,
  commandItems,
  panelItems,
  resolveSurface,
  slotItems,
  surfaceItems,
} from './registry.ts'
import type { CommandItem } from './registry.ts'
import type { CommandContribution, UltimateActions, UltimateContext } from './types.ts'

/** Shell state that survives reloads and follows across tabs (see ui-state.ts). */
export const shellKeys = {
  conversation: 'shell.conversation',
  /** The chosen surface's id. */
  surface: 'shell.surface',
  /** `{ id, title }` of the surface on screen, which the agent's prompt names (extensions/surfaces). */
  shownSurface: 'shell.shownSurface',
  panel: 'shell.panel',
  panelOpen: 'shell.panelOpen',
  sidebarOpen: 'shell.sidebarOpen',
  /** `{ open, width }` of a surface's `Dock`, under `shell.dock.<surface id>.<side>`. */
  dock: 'shell.dock',
} as const

/** The shown surface, from the installed facets, the chosen id, and the project's `defaultSurface`; now by default. */
export function shownSurface(
  records = registry.getSnapshot(),
  chosen = uiState.get(shellKeys.surface),
  preferred = store.getState().system?.project.settings.defaultSurface,
) {
  return resolveSurface(surfaceItems(records), {
    chosen: typeof chosen === 'string' ? chosen : undefined,
    preferred: typeof preferred === 'string' ? preferred : undefined,
    loading: records.some((record) => record.loading),
  })
}

/**
 * Regions the shown surface renders (`Sidebar`, `Panels` mount themselves here); their header toggles and commands
 * exist only while they do.
 */
const regions = new Map<'sidebar' | 'panels', number>()
const regionListeners = new Set<() => void>()
export const layout = {
  mount: (region: 'sidebar' | 'panels') => {
    regions.set(region, (regions.get(region) ?? 0) + 1)
    for (const listener of regionListeners) listener()
    return () => {
      regions.set(region, (regions.get(region) ?? 1) - 1)
      for (const listener of regionListeners) listener()
    }
  },
  has: (region: 'sidebar' | 'panels') => (regions.get(region) ?? 0) > 0,
  subscribe: (listener: () => void) => {
    regionListeners.add(listener)
    return () => {
      regionListeners.delete(listener)
    }
  },
}

const flag = (key: string, fallback: boolean) => {
  const value = uiState.get(key)
  return typeof value === 'boolean' ? value : fallback
}

export const actions: UltimateActions = {
  switchConversation: (id) => uiState.set(shellKeys.conversation, id),
  showSurface: (id) => uiState.set(shellKeys.surface, id),
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
    if (!applies(command, context)) return
    void Promise.resolve()
      .then(() => command.run(context))
      .catch((error: unknown) =>
        store.notify({
          level: 'error',
          message: `${command.title}${command.extension === 'core' ? '' : ` (${command.extension})`}: ${messageOf(error)}`,
        }),
      )
  },
  open: (dialog) => store.setUi({ dialogs: { ...store.getState().ui.dialogs, [dialog]: true } }),
  close: (dialog) => store.setUi({ dialogs: { ...store.getState().ui.dialogs, [dialog]: false } }),
  openPalette: () => store.setUi({ paletteOpen: true }),
  focusComposer: () => document.getElementById('composer-input')?.focus(),
  setTheme: (theme) => store.setUi({ theme }),
}

export function currentContext(): UltimateContext {
  return {
    ...actions,
    conversationId: store.getState().view?.conversation.id,
    surface: store.getState().ui.surface?.id ?? HOME,
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const reported = new Set<string>()
/** `commandApplies` that reports a broken `when` once as a notice naming its extension. */
export function applies(command: CommandItem, context: UltimateContext = currentContext()) {
  return commandApplies(command, context, (item, error) => {
    const message = `extension ${item.extension}: command ${item.id} is hidden, its when() threw: ${messageOf(error)}`
    if (reported.has(message)) return
    reported.add(message)
    // Predicates run while React renders the palette; notify after that render.
    queueMicrotask(() => store.notify({ level: 'error', message }))
  })
}

/** The shell's own commands: the palette and its regions. Feature commands come from their extensions. */
const core: CommandContribution[] = [
  {
    id: 'ultimate.palette',
    title: 'Command palette',
    keys: 'mod+k',
    run: (context) => context.openPalette(),
  },
  {
    id: 'ultimate.panel',
    title: 'Toggle the right panel',
    keys: 'mod+alt+b',
    when: () => layout.has('panels') && panelItems(registry.getSnapshot()).length > 0,
    run: (context) => context.togglePanel(),
  },
  {
    id: 'ultimate.sidebar',
    title: 'Toggle the sidebar',
    keys: 'mod+b',
    when: () => layout.has('sidebar') && slotItems(registry.getSnapshot(), 'sidebar').length > 0,
    run: (context) => context.toggleSidebar(),
  },
]
export const coreCommands: CommandItem[] = core.map((command) => ({
  ...command,
  group: 'Ultimate',
  extension: 'core',
}))

/** Core commands, a switch per surface (`mod+1…9` for the first nine), then extension commands; later wins an id. */
export function allCommands(): CommandItem[] {
  const records = registry.getSnapshot()
  return commandItems(records, [
    ...coreCommands,
    ...surfaceItems(records).map((surface, index) => ({
      id: `ultimate.surface.${surface.id}`,
      title: `Switch to ${surface.title}`,
      keys: index < 9 ? `mod+${index + 1}` : undefined,
      group: 'Surfaces',
      extension: surface.extension,
      run: () => actions.showSurface(surface.id),
    })),
  ])
}
