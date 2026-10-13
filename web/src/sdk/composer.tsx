import type { ConfigureRequest } from '../../../shared/protocol.ts'
import { createContext, useContext } from 'react'

export type ComposerTarget = 'conversation' | 'new'
export type NewConversationChoices = {
  model?: NonNullable<ConfigureRequest['model']>
  thinkingLevel?: ConfigureRequest['thinkingLevel']
}
export const newConversationKey = 'ultimate.newConversation'
export const ComposerContext = createContext<{ target: ComposerTarget }>({ target: 'conversation' })

/** The composer owning this toolbar or status contribution. */
export function useComposer() {
  return useContext(ComposerContext)
}
