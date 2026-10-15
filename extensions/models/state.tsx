import { useSyncExternalStore } from 'react'
import {
  api,
  getState,
  newConversationKey,
  useComposer,
  useConversation,
  useModels,
  useNewConversationConfiguration,
} from '@/sdk'
import type { ComposerTarget, NewConversationChoices, ModelsResponse, UltimateActions } from '@/sdk'

export type ModelInfo = ModelsResponse['models'][number]
export type ProviderInfo = ModelsResponse['providers'][number]
export type ThinkingLevel = ModelInfo['thinkingLevels'][number]

/** Dialog ids this extension's overlays read with `useDialog`. */
export const dialogs = {
  picker: 'models.picker',
  thinking: 'models.thinking',
  login: 'models.login',
} as const

/** The composer's selected model and thinking, or the shown conversation's configuration. */
export function useCurrentModel(target?: ComposerTarget, source?: number) {
  const composer = useComposer()
  target ??= composer.target
  source ??= composer.source
  const defaults = useNewConversationConfiguration(target === 'new', source)
  const { agent, loading } = useConversation()
  const models = useModels()
  const configuration = target === 'new' ? defaults.configuration : agent
  const ref = configuration.model
  const model = models?.models.find(
    (candidate) => candidate.provider === ref?.provider && candidate.id === ref.modelId,
  )
  return {
    ref,
    model,
    thinking: configuration.thinkingLevel,
    models,
    loading: target === 'new' ? defaults.loading : loading,
  }
}

/** Pending choices are remembered; existing conversations are configured immediately. */
export function configureTarget(change: NewConversationChoices, target: ComposerTarget) {
  if (target === 'conversation') return api.configure(change)
  const choices = (getState().shared?.[newConversationKey] ?? {}) as NewConversationChoices
  return api.updateUi({ set: { [newConversationKey]: { ...choices, ...change } } })
}

export function selectModel(model: ModelInfo, target: ComposerTarget) {
  const choices = (getState().shared?.[newConversationKey] ?? {}) as NewConversationChoices
  const thinkingLevel =
    choices.thinkingLevel && model.thinkingLevels.includes(choices.thinkingLevel)
      ? choices.thinkingLevel
      : model.thinkingLevels[0]
  return configureTarget(
    {
      model: { provider: model.provider, modelId: model.id },
      ...(target === 'new' && { thinkingLevel }),
    },
    target,
  )
}

let picker: { target: ComposerTarget; source?: number } = { target: 'conversation' }
/** Open the model picker for `target`; a new branch's `source` supplies the model it shows as current. */
export function openPicker(
  actions: Pick<UltimateActions, 'open'>,
  target: ComposerTarget = 'conversation',
  source?: number,
) {
  picker = { target, source }
  actions.open(dialogs.picker)
}
export function getPicker() {
  return picker
}

/** The supported level after `current` in Pi's order, wrapping around, as Pi's Shift+Tab does. */
export function nextThinking(current: ThinkingLevel | undefined, model: ModelInfo) {
  const levels = model.thinkingLevels
  return levels[(levels.indexOf(current ?? 'off') + 1) % levels.length]
}

/** Which provider the login dialog should open on; set just before it opens. */
let loginProvider: string | undefined
let loginTarget: ComposerTarget = 'conversation'
export function getLoginTarget() {
  return loginTarget
}
const listeners = new Set<() => void>()
export function openLogin(
  actions: Pick<UltimateActions, 'open' | 'close'>,
  provider?: string,
  target: ComposerTarget = 'conversation',
) {
  loginProvider = provider
  loginTarget = target
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
