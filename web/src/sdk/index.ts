/**
 * The extension SDK: everything a `web.tsx` needs besides components (`@/components/ui/*`, `@/components/ai/*`).
 * The guide is extensions/README.md.
 */
export { defineWebExtension, definePoint, ParkedRuns, provide } from './types.ts'
export { events, useEvent } from './events.ts'
export { resumed } from './resume.ts'
export type {
  ChatCallTest,
  ChatContribution,
  ChatQuietTest,
  ChatRow,
  ChatSummaryProps,
  IntroContribution,
  ChatDocs,
  CommandContribution,
  ComposerRenderer,
  Contribution,
  DocumentContribution,
  DocumentProps,
  EntryRenderer,
  InboxRenderer,
  LinkRenderer,
  PanelContribution,
  Point,
  Provision,
  SlotName,
  SurfaceContribution,
  ToolCallView,
  ToolLineRenderer,
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
/** A card that folds to one quiet line in a chat, and whether one is open; the reader's choice survives reloads. */
export { Fold, useFold } from '../app/fold.tsx'
/** A message's footer as the transcript shows it: details such as usage, time, copy, go back and a reference link. */
export { MessageActions } from '../app/message-actions.tsx'
/** Renders with the value another extension provides for your point; see `definePoint`. */
export { Provided } from '../app/boundary.tsx'
export { api } from './client.ts'
export { ActionError } from './api.ts'
export type { ActionOptions, Api } from './api.ts'
export type { UseActionOptions } from './hooks.ts'
/** Typed refs for a project extension's own documents and actions; built-ins keep theirs in `refs.ts`. */
export { actionRef, docRef } from '../../../shared/extension-api.ts'
export type { ActionRef, DocRef } from '../../../shared/extension-api.ts'
export {
  getConversation,
  getState,
  refreshModels,
  useAction,
  useChat,
  useCommands,
  useConnection,
  useConversation,
  useConversations,
  useDialog,
  useDoc,
  useDocKind,
  useDocOf,
  useDocumentRenderers,
  useEvents,
  useExtensionUiState,
  useExtensions,
  useIntro,
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
export { defineEvent } from '../../../shared/events.ts'
export type { EventContext, EventData, EventRecord, EventToken } from '../../../shared/events.ts'
export { touchKeyboard, useViewport } from './viewport.ts'
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
