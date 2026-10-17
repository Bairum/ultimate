import { useSyncExternalStore } from 'react'
import { api, useConversation, useModels } from '@/sdk'
import type { ModelsResponse, UltimateActions } from '@/sdk'

export type ModelInfo = ModelsResponse['models'][number]
export type ProviderInfo = ModelsResponse['providers'][number]
export type ThinkingLevel = ModelInfo['thinkingLevels'][number]

/** Dialog ids this extension's overlays read with `useDialog`. */
export const dialogs = {
  picker: 'models.picker',
  thinking: 'models.thinking',
  login: 'models.login',
} as const

/** The shown conversation's model and thinking. */
export function useCurrentModel() {
  const { agent, loading } = useConversation()
  const models = useModels()
  const ref = agent.model
  const model = models?.models.find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
  )
  return {
    ref,
    model,
    thinking: agent.thinkingLevel,
    models,
    loading,
  }
}

export function selectModel(model: ModelInfo) {
  return api.configure({ model: { provider: model.provider, modelId: model.id } })
}

export function openPicker(actions: Pick<UltimateActions, 'open'>) {
  actions.open(dialogs.picker)
}

/** The supported level after `current` in Pi's order, wrapping around, as Pi's Shift+Tab does. */
export function nextThinking(current: ThinkingLevel | undefined, model: ModelInfo) {
  const levels = model.thinkingLevels
  return levels[(levels.indexOf(current ?? 'off') + 1) % levels.length]
}

/** Which provider the login dialog should open on; set just before it opens. */
let loginProvider: string | undefined
const listeners = new Set<() => void>()
export function openLogin(actions: Pick<UltimateActions, 'open' | 'close'>, provider?: string) {
  loginProvider = provider
  for (const listener of listeners) listener()
  actions.close(dialogs.picker)
  actions.open(dialogs.login)
}
export function useLoginProvider() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => loginProvider,
  )
}

/** 128k, 1M: a context window. */
export function formatWindow(tokens: number) {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}k`
}

/** Dollars per million tokens, compact: 0.1, 2, 12.5. */
export const price = (value: number) => (value === 0 ? '0' : String(+value.toFixed(3)))

/** How a provider is configured, for labels: `stored`, `env`, … */
export function authLabel(provider: ProviderInfo | undefined) {
  if (!provider?.status.configured) return undefined
  const { source, label } = provider.status
  if (label) return label
  if (source === 'environment') return 'env'
  if (source === 'models_json_key' || source === 'models_json_command') return 'models.json'
  return source ?? 'configured'
}
