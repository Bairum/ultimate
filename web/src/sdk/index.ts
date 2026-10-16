/**
 * The extension SDK: everything a `web.tsx` needs besides components (`@/components/ui/*`, `@/components/ai/*`).
 * The guide is extensions/README.md.
 */
export { defineWebExtension } from './types.ts'
export { events, useEvent } from './events.ts'
export { resumed } from './resume.ts'
export type {
  CommandContribution,
  Contribution,
  ConversationDraft,
  DocumentContribution,
  DocumentProps,
  EntryRenderer,
  InboxRenderer,
  LinkRenderer,
  PanelContribution,
  SlotName,
  SurfaceContribution,
  ToolCallView,
  ToolRenderer,
  UltimateActions,
  UltimateContext,
  WebExtension,
} from './types.ts'
/** Building blocks of surfaces; see "Surfaces" in extensions/README.md. */
export {
  Conversation,
  Dock,
  Header,
  Panels,
  Sidebar,
  Slot,
  StatusLine,
} from '../app/primitives.tsx'
/** Isolates another extension's component you render, such as a document renderer: it throws into an error card. */
export { ExtensionBoundary } from '../app/boundary.tsx'
export { api } from './client.ts'
export { ActionError } from './api.ts'
export type { Api } from './api.ts'
export {
  getConversation,
  getState,
  getUiState,
  refreshModels,
  useAction,
  useCommands,
  useConnection,
  useConversation,
  useConversations,
  useDialog,
  useDoc,
  useDocOf,
  useDocumentRenderers,
  useExtensionUiState,
  useExtensions,
  useModels,
  useNotices,
  useNow,
  useRestart,
  useReady,
  useStore,
  useSystem,
  useTasks,
  useToolDuration,
  useTranscript,
  useUiState,
  useUltimate,
} from './hooks.ts'
export type { ActionState, ConversationState, Restart } from './hooks.ts'
export { useViewport } from './viewport.ts'
export type { Viewport } from './viewport.ts'
export type { Connection, State } from './store.ts'
export type { DocumentItem } from './registry.ts'
export {
  elidePath,
  errorMessage,
  formatBytes,
  formatDuration,
  formatTime,
  formatTokens,
  shortenPath,
} from './format.ts'
/** Class names joined, Tailwind conflicts resolved: `cn('px-2', active && 'bg-accent')`. */
export { cn } from 'cn'
export { formatKeys } from './keys.ts'
export type {
  ConversationSummary,
  ExtensionActionRequest,
  ExtensionActionResponse,
  ExtensionInfo,
  ModelsResponse,
  Notice,
  SystemInfo,
} from '../../../shared/protocol.ts'
export type {
  AgentState,
  ConversationView,
  EntryRecord,
  InboxItem,
  JsonObject,
  LiveState,
  TaskGraph,
  TaskGraphNode,
  ToolDiagnostic,
  ToolSlot,
  UsageState,
} from '@earendil-works/pi-durable'
export type { JsonValue } from '@earendil-works/chord'
export type {
  AssistantMessage,
  AuthEvent,
  AuthPrompt,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai'

export { NewConversationComposer } from '../app/composer.tsx'
export {
  useComposer,
  newConversationKey,
  useNewConversationConfiguration,
  getNewConversationConfiguration,
} from './composer.tsx'
export type { ComposerTarget, NewConversationChoices } from './composer.tsx'
