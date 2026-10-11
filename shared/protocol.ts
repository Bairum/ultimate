import type { JsonValue } from '@earendil-works/chord'
import type { Op } from '@earendil-works/chord/delta'
import type { AuthType, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ConversationView, JsonObject, ModelRef, TaskGraph } from '@earendil-works/pi-durable'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

export interface SubmitRequest {
  text: string
  whenBusy?: 'steer' | 'followUp'
}
export interface SubmitResponse {
  submissionId: number
}
export interface ConfigureRequest {
  model?: ModelRef
  thinkingLevel?: ModelThinkingLevel
}
export interface CompactResponse {
  taskId: number
}
export interface EmptyResponse {
  ok: true
}
export type Workspace = {
  kind: 'worktree'
  path: string
  branch: string
  base: string
  source: string
  targetBranch: string | null
  targetHead?: string
  state: 'active' | 'discarded'
  preparation: 'pending' | 'ready' | 'error'
  error?: string
  landed?: string
}
export interface ConversationSummary {
  id: number
  parentConversationId?: number
  ownerTaskId?: number
  /** A short name its creator gave it, shown before its title. */
  label?: string
  title?: string
  cwd?: string
  workspace?: Workspace
  busy: boolean
  /** Timestamp (ms) of its latest user message; absent when it has none. */
  inputAt?: number
  /** Timestamp (ms) of its latest assistant message; absent when it has none. */
  answerAt?: number
}
export interface CreateConversationRequest {
  cwd?: string
  title?: string
  isolate?: 'none' | 'worktree'
  /** Required for isolated creation; retries refer to the same new conversation. */
  requestId?: string
}
export interface CreateConversationResponse {
  id: number
}
export interface ExtensionActionRequest {
  args: JsonValue
  conversationId?: number
}
export interface ExtensionActionResponse {
  result: JsonValue
}
export interface ExtensionInfo {
  name: string
  enabled: boolean
  source: 'builtin' | 'user' | 'project'
  replaces?: 'builtin'
  layer: 'default' | 'user' | 'project' | 'folder'
  path: string
  actions: string[]
  readme?: string
  facets: { server: boolean; web: boolean }
  server?: {
    loadedAt?: string
    tools: string[]
    sections: string[]
    hooks: number
    docs: string[]
    secrets?: { name: string; description: string; url?: string }[]
    error?: string
  }
}
export interface BuildEntry {
  id: string
  at: string
  generation: number
  changed: string[]
}
export interface BuildInfo extends BuildEntry {
  core: string
  extensions: Record<string, string>
  history: BuildEntry[]
}
export interface SystemInfo {
  build: BuildInfo
  machine: {
    hostname: string
    home: string
    platform: string
    release: string
    arch: string
    cpuModel: string
    cpuCount: number
    totalMemory: number
    freeMemory: number
    user: string
  }
  process: {
    pid: number
    node: string
    startedAt: string
    generation: number
    url: string
    activationError?: string
  }
  access: { origins: string[] }
  persistence: { kind: 'sqlite'; path: string; sizeBytes: number; walBytes: number }
  execution: { kind: 'node-local'; defaultCwd: string; workspaces?: true }
  project: {
    root: string
    name: string
    config: boolean
    decision: boolean | null
    readme?: string
    settings: Record<string, JsonValue>
    settingsError?: string
  }
  code: { ultimateRoot: string; branch: string; sha: string; dirty: boolean; coreStale?: boolean }
  extensionDiagnostics: string[]
  extensions: ExtensionInfo[]
  skills: { name: string; description: string; path: string }[]
  contextFiles: string[]
}
export interface Notice {
  level: 'info' | 'warning' | 'error'
  message: string
}
export interface ModelsResponse {
  providers: {
    id: string
    name: string
    authTypes: { type: AuthType; name: string }[]
    status: ReturnType<ModelRuntime['getProviderAuthStatus']>
    isUsingSubscription: boolean
  }[]
  models: {
    provider: string
    id: string
    name: string
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    thinkingLevels: ModelThinkingLevel[]
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
    available: boolean
  }[]
}
/** `POST /api/ui`: set and delete keys of the root conversation's `ultimate.ui` document. */
export interface UiUpdateRequest {
  set?: Record<string, JsonValue>
  delete?: string[]
}
export interface ServerEvents {
  system: SystemInfo
  conversations: ConversationSummary[]
  view: ConversationView
  ops: readonly Op[]
  ui: { value: Readonly<Record<string, JsonValue>> }
  uiOps: { ops: readonly Op[] }
  doc: { kind: string; value: Readonly<JsonObject> | null }
  docOps: { kind: string; ops: readonly Op[] }
  tasks: TaskGraph
  notice: Notice
}
