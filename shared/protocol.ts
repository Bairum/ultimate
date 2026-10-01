import type { Op } from '@earendil-works/chord/delta'
import type { AuthEvent, AuthPrompt, AuthType, ModelThinkingLevel } from '@earendil-works/pi-ai'
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
export interface CompactRequest {
  instructions?: string
}
export interface CompactResponse {
  taskId: number
}
export interface LoginRequest {
  provider: string
  type: AuthType
}
export interface LoginResponse {
  flowId: string
}
export interface AnswerRequest {
  value: string
}
export interface LogoutRequest {
  provider: string
}
export interface EmptyResponse {
  ok: true
}
export interface ErrorResponse {
  error: string
}
export interface ConversationSummary {
  id: number
  parentConversationId?: number
  ownerTaskId?: number
  title?: string
  cwd?: string
  busy: boolean
}
export interface CreateConversationRequest {
  cwd?: string
  title?: string
}
export interface CreateConversationResponse {
  id: number
}
export interface ExtensionInfo {
  name: string
  readme?: string
  facets: { server: boolean; web: boolean }
  server?: {
    loadedAt?: string
    tools: string[]
    sections: string[]
    hooks: number
    docs: string[]
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
  agents?: string
  history: BuildEntry[]
}
export interface SystemInfo {
  build: BuildInfo
  machine: {
    hostname: string
    platform: string
    release: string
    arch: string
    cpuModel: string
    cpuCount: number
    totalMemory: number
    freeMemory: number
    user: string
  }
  process: { pid: number; node: string; startedAt: string; generation: number; url: string }
  persistence: { kind: 'sqlite'; path: string; sizeBytes: number; walBytes: number }
  execution: { kind: 'node-local'; defaultCwd: string }
  code: { repoRoot: string; branch: string; sha: string; dirty: boolean; coreStale?: boolean }
  extensions: ExtensionInfo[]
  skills: { name: string; description: string; path: string }[]
  contextFiles: string[]
  agents: { name: string; description: string; path: string }[]
}
type WirePrompt<T> = T extends AuthPrompt ? Omit<T, 'signal'> : never
export type BrowserAuthPrompt = WirePrompt<AuthPrompt>
export type AuthFlowEvent =
  | { flowId: string; type: 'prompt'; prompt: BrowserAuthPrompt }
  | { flowId: string; type: 'event'; event: AuthEvent }
  | { flowId: string; type: 'complete' | 'cancel' }
  | { flowId: string; type: 'error'; error: string }
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
export interface ServerEvents {
  system: SystemInfo
  conversations: ConversationSummary[]
  view: ConversationView
  ops: readonly Op[]
  doc: { kind: string; value: Readonly<JsonObject> | null }
  docOps: { kind: string; ops: readonly Op[] }
  tasks: TaskGraph
  auth: AuthFlowEvent
  notice: Notice
}
