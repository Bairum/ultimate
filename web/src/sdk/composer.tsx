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
/**
 * The configuration used by new-target controls and validation: the user's choices over the defaults of `source`, the
 * conversation a branch starts from. Without a source (a new root) the defaults are the project's, conversation 1's.
 */
export function useNewConversationConfiguration(enabled = true, source?: number) {
  const [choices] = useUiState<NewConversationChoices>(newConversationKey, {})
  const shown = useConversation()
  const available = useExtensions().some((extension) => extension.name === 'models')
  const live = shown.id === (source ?? 1)
  const fetched = useAction<NewConversationChoices>(
    'models',
    'defaultConfiguration',
    source === undefined ? null : { id: source },
    { enabled: enabled && available && !live },
  )
  const defaults = live ? shown.agent : fetched.data
  return {
    configuration: {
      model: choices.model ?? defaults?.model,
      thinkingLevel: choices.thinkingLevel ?? defaults?.thinkingLevel,
    },
    available,
    loading: enabled && available && (shown.loading || (!live && fetched.loading)),
    error: fetched.error,
  }
}

/** Commands read the same defaults freshly, without depending on the shown conversation. */
export async function getNewConversationConfiguration(source?: number) {
  const defaults = await api.action<NewConversationChoices>(
    'models',
    'defaultConfiguration',
    source === undefined ? null : { id: source },
  )
  const choices = (getState().shared?.[newConversationKey] ?? {}) as NewConversationChoices
  return {
    model: choices.model ?? defaults.model,
    thinkingLevel: choices.thinkingLevel ?? defaults.thinkingLevel,
  }
}

export const ComposerContext = createContext<{
  target: ComposerTarget
  isolated?: boolean
  /** The conversation a new branch starts from; absent for a new root. */
  source?: number
}>({
  target: 'conversation',
})

/** The composer owning this toolbar or status contribution. */
export function useComposer() {
  return useContext(ComposerContext)
}
