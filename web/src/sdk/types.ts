import type { ComponentType } from 'react'
import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { EntryRecord, ToolDiagnostic } from '@earendil-works/pi-durable'

/** Named places in the shell that extensions fill with components. */
export type SlotName =
  | 'sidebar'
  | 'header.right'
  | 'statusline.left'
  | 'statusline.right'
  | 'composer.toolbar'
  | 'overlay'

/** A slot component, optionally with an `order` (default 0; ties keep folder-name order). */
export type Contribution = ComponentType | { component: ComponentType; order?: number }

/** A tab in the right panel. */
export interface PanelContribution {
  id: string
  title: string
  icon?: ComponentType<{ className?: string }>
  component: ComponentType
  order?: number
}

/** A full main-area app view; while it shows, the conversation moves to a side dock with the composer. */
export interface ViewContribution {
  /** Global id, stored in `shell.view`; prefix it with the extension name when it is generic. */
  id: string
  title: string
  icon?: ComponentType<{ className?: string }>
  component: ComponentType
  order?: number
}

/** One tool call as the transcript sees it: the model's call, live progress, and the result. */
export interface ToolCallView {
  /** Tool call id, shared by the call and its result. */
  id: string
  name: string
  /** Arguments; partial while the model is still streaming them. */
  args: ToolCall['arguments']
  /**
   * `streaming`: the model is still writing the call. `pending`: queued. `running`: executing.
   * `done`/`error`: finished. `interrupted`: the run ended without a result.
   */
  status: 'streaming' | 'pending' | 'running' | 'done' | 'error' | 'interrupted'
  /** Streamed output while running; the result's text once finished. */
  output: string
  /** Last `details()` while running, the result's details once finished; each tool defines its shape. */
  details?: unknown
  diagnostics: readonly ToolDiagnostic[]
  /** What the output bounds dropped while running. */
  dropped?: { bytes: number; lines: number }
  /** Epoch ms when the calling response started and when the result was written. */
  startedAt?: number
  endedAt?: number
  result?: ToolResultMessage
}

export type ToolRenderer = ComponentType<{ call: ToolCallView }>
export type EntryRenderer = ComponentType<{ entry: EntryRecord }>

/** Navigation and shell actions, passed to commands and returned by `useUltimate()`. */
export interface UltimateActions {
  switchConversation: (id: number) => void
  /** Show view `id` in the main area, or the conversation when `id` is undefined. */
  openView: (id: string | undefined) => void
  /** Open the right panel, on tab `id` when given. */
  openPanel: (id?: string) => void
  closePanel: () => void
  togglePanel: () => void
  toggleSidebar: () => void
  runCommand: (id: string) => void
  /** Open or close a dialog by id; an overlay reads it with `useDialog(id)`. */
  open: (dialog: string) => void
  close: (dialog: string) => void
  openPalette: () => void
  focusComposer: () => void
}
export interface UltimateContext extends UltimateActions {
  /** The shown conversation, once known. */
  conversationId?: number
}

export interface CommandContribution {
  id: string
  title: string
  /** Shortcut: `mod+shift+m`, or a sequence such as `mod+k m` (`mod` is ⌘ on macOS, Ctrl elsewhere). */
  keys?: string
  /** Palette group; defaults to the extension name. */
  group?: string
  /** Hide the command when this returns false. */
  when?(context: UltimateContext): boolean
  /** Return a promise to have its failure reported. */
  run(context: UltimateContext): void | Promise<unknown>
}

/** The browser facet of an extension: `extensions/<name>/web.tsx` default-exports one. */
export interface WebExtension {
  slots?: Partial<Record<SlotName, Contribution | readonly Contribution[]>>
  panels?: readonly PanelContribution[]
  views?: readonly ViewContribution[]
  /** Tool-call renderers by tool name. */
  tools?: Readonly<Record<string, ToolRenderer>>
  /** Entry renderers by entry kind; they also replace the core renderer of a `pi.*` kind. */
  entries?: Readonly<Record<string, EntryRenderer>>
  commands?: readonly CommandContribution[]
}

export function defineWebExtension(extension: WebExtension): WebExtension {
  return extension
}
