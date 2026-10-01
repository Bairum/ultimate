/**
 * The extension SDK: everything a `web.tsx` needs besides components (`@/components/ui/*`, `@/components/ai/*`).
 * The guide is extensions/README.md.
 */
export { defineWebExtension } from './types.ts'
export type {
  CommandContribution,
  Contribution,
  EntryRenderer,
  PanelContribution,
  SlotName,
  ToolCallView,
  ToolRenderer,
  UltimateActions,
  UltimateContext,
  ViewContribution,
  WebExtension,
} from './types.ts'
export { api } from './client.ts'
export type { Api } from './api.ts'
export {
  useAuthFlows,
  useCommands,
  useConnection,
  useConversation,
  useConversations,
  useDialog,
  useDoc,
  useExtensionUiState,
  useExtensions,
  useModels,
  useNotices,
  useNow,
  useStore,
  useSystem,
  useTasks,
  useToolDuration,
  useUiState,
  useUltimate,
} from './hooks.ts'
export type { ConversationState } from './hooks.ts'
export type { AuthFlow, Connection, State } from './store.ts'
export {
  elidePath,
  formatBytes,
  formatDuration,
  formatTokens,
  homeOf,
  shortenPath,
} from './format.ts'
/** Class names joined, Tailwind conflicts resolved: `cn('px-2', active && 'bg-accent')`. */
export { cn } from 'cn'
export { formatKeys } from './keys.ts'
export type {
  AuthFlowEvent,
  BrowserAuthPrompt,
  ConversationSummary,
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
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai'
