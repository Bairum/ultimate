import type { ComponentType, ReactNode } from 'react'
import type { ImageContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { EntryRecord, InboxItem, JsonObject, ToolDiagnostic } from '@earendil-works/pi-durable'
import type { ConfigureRequest } from '../../../shared/protocol.ts'

/** Named places in the shell that extensions fill with components. */
export type SlotName =
  | 'sidebar'
  | 'header.right'
  | 'statusline.left'
  | 'statusline.right'
  | 'composer.toolbar'
  | 'composer.status'
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

/**
 * A full-screen composition the user switches to: the built-in Agent surface (`extensions/agent`) or an app. Build it
 * from the primitives in `@/sdk` (`Header`, `Conversation`, `Dock`, `StatusLine`, …) and your own components.
 */
export interface SurfaceContribution {
  /** Global id, stored in `shell.surface`; prefix it with the extension name when it is generic. `agent` is the home. */
  id: string
  title: string
  icon: ComponentType<{ className?: string }>
  /** One line for the switcher. */
  description?: string
  /** Position after Agent in the switcher, ⌘K, and `mod+1…9`; lower first (default 0), then by title. */
  order?: number
  component: ComponentType
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
  /** Images of the result, such as screenshots; `ToolImages` from `@/components/ai/tool` renders them. */
  images: readonly ImageContent[]
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

/** `core` is the rendering so far, starting with the generic tool card. */
export type ToolRenderer = ComponentType<{ call: ToolCallView; core: ReactNode }>
/** `core` is the core's rendering of the entry: return it for entries you leave alone, or wrap it. */
export type EntryRenderer = ComponentType<{ entry: EntryRecord; core: ReactNode }>

export type InboxRenderer = ComponentType<{ item: InboxItem; core: ReactNode; cancel: ReactNode }>

/** What a document renderer receives: the shown conversation's document of its kind, live. */
export interface DocumentProps {
  value: Readonly<JsonObject>
  conversationId: number
}
/**
 * How the Documents tab shows one kind of extension document, a server facet's `docs` export (`ultimate.plan`).
 * Kinds without one show as a JSON tree.
 */
export interface DocumentContribution {
  kind: string
  title: string
  icon?: ComponentType<{ className?: string }>
  component: ComponentType<DocumentProps>
}

/** Navigation and shell actions, passed to commands and returned by `useUltimate()`. */
export interface UltimateActions {
  switchConversation: (id: number) => void
  /** Show surface `id` (`agent` is the home); the conversation keeps running. */
  showSurface: (id: string) => void
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
  /** Switch this browser to the light or dark theme; `getState().ui.theme` is the current one. */
  setTheme: (theme: 'dark' | 'light') => void
}
export interface UltimateContext extends UltimateActions {
  /** The shown conversation, once known. */
  conversationId?: number
  /** A stored message targeted by a contextual command. */
  entryId?: number
  /** The id of the surface on screen: Agent while a chosen surface that failed falls back. */
  surface: string
}

export interface CommandContribution {
  id: string
  title: string
  /** Shortcut: `mod+shift+m`, or a sequence such as `mod+k m` (`mod` is ⌘ on macOS, Ctrl elsewhere). */
  keys?: string
  /** Palette group; defaults to the extension name. */
  group?: string
  /**
   * Fire a plain-key shortcut (`escape`, `shift+tab`) even while the user types in the composer (not in other inputs),
   * though not while a dialog is open.
   */
  whileTyping?: boolean
  /** Hide the command when this returns false. */
  when?(context: UltimateContext): boolean
  /** Return a promise to have its failure reported. */
  run(context: UltimateContext): void | Promise<unknown>
}

/** A composer submission for a new conversation; extensions own how it starts. */
export interface ConversationDraft {
  prompt: string
  images?: { data: string; mimeType: string }[]
  from?: number
  at?: number
  /** Start a new root instead of a branch. */
  root?: boolean
  isolated?: boolean
  model?: { provider: string; modelId: string }
  thinkingLevel?: ConfigureRequest['thinkingLevel']
}

/** The browser facet of an extension: `extensions/<name>/web.tsx` default-exports one. */
export interface WebExtension {
  slots?: Partial<Record<SlotName, Contribution | readonly Contribution[]>>
  panels?: readonly PanelContribution[]
  surfaces?: readonly SurfaceContribution[]
  /** Tool-call renderers by tool name. */
  tools?: Readonly<Record<string, ToolRenderer>>
  /** Entry renderers by entry kind; they also replace the core renderer of a `pi.*` kind. */
  entries?: Readonly<Record<string, EntryRenderer>>
  inbox?: InboxRenderer
  /** Starts a new conversation; the last contribution in discovery order wins. */
  start?: (draft: ConversationDraft) => Promise<{ id: number }>
  /** Contributions to the hover action row on stored messages, in discovery order. */
  messageActions?: readonly ComponentType<{ entry: EntryRecord }>[]
  /** Readouts on the hover action row on stored messages, before its time, in discovery order. */
  messageDetails?: readonly ComponentType<{ entry: EntryRecord }>[]
  /** Document renderers; a later facet wins a kind. */
  documents?: readonly DocumentContribution[]
  commands?: readonly CommandContribution[]
}

export function defineWebExtension(extension: WebExtension): WebExtension {
  return extension
}
