import type { ConfigureRequest } from '../../../shared/protocol.ts'
import { createContext, useContext } from 'react'
import { api } from './client.ts'
import { getState, useAction, useConversation, useExtensions, useUiState } from './hooks.ts'

export type ComposerTarget = 'conversation' | 'new'
export type NewConversationChoices = {
  model?: NonNullable<ConfigureRequest['model']>
  thinkingLevel?: ConfigureRequest['thinkingLevel']
}
export const newConversationKey = 'ultimate.newConversation'
/** The configuration used by new-target controls and validation. */
export function useNewConversationConfiguration(enabled = true) {
  const [choices] = useUiState<NewConversationChoices>(newConversationKey, {})
  const shown = useConversation()
  const available = useExtensions().some((extension) => extension.name === 'models')
  const root = useAction<NewConversationChoices>('models', 'rootConfiguration', null, {
    enabled: enabled && available && shown.id !== 1,
  })
  const defaults = shown.id === 1 ? shown.agent : root.data
  return {
    configuration: {
      model: choices.model ?? defaults?.model,
      thinkingLevel: choices.thinkingLevel ?? defaults?.thinkingLevel,
    },
    available,
    loading: enabled && available && (shown.loading || (shown.id !== 1 && root.loading)),
    error: root.error,
  }
}

/** Commands read the same defaults freshly, without depending on the shown conversation. */
export async function getNewConversationConfiguration() {
  const root = await api.action<NewConversationChoices>('models', 'rootConfiguration')
  const choices = (getState().shared?.[newConversationKey] ?? {}) as NewConversationChoices
  return {
    model: choices.model ?? root.model,
    thinkingLevel: choices.thinkingLevel ?? root.thinkingLevel,
  }
}

export const ComposerContext = createContext<{ target: ComposerTarget; isolated?: boolean }>({
  target: 'conversation',
})

/** The composer owning this toolbar or status contribution. */
export function useComposer() {
  return useContext(ComposerContext)
}
