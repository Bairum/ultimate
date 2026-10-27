/**
 * Models in the browser: provider login flows, which a conversation's login dialog follows, and the actions that
 * start, answer and cancel them or log out, and the event of a completed login or logout. Browser-safe.
 */
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'

/** One login flow as the browser sees it. Answers and credentials never enter it. */
export type LoginFlow = {
  provider: string
  type: AuthType
  status: 'running' | 'complete' | 'cancel' | 'error'
  /** The prompt waiting for an answer, without its `signal`. */
  prompt?: AuthPrompt
  events: AuthEvent[]
  error?: string
}

/** The login flows started from a conversation, by flow id, on that conversation; finished ones are kept for a while. */
export const LoginDoc = docRef<{ flows: Record<string, LoginFlow> }>('models.login')

/** `{ provider, type }` → `{ flowId }`: start logging in to `provider` for the calling conversation. */
export const LoginAction = actionRef<{ provider: string; type: AuthType }, { flowId: string }>(
  'models',
  'login',
)
/** `{ flowId, value }` → null: answer the flow's pending prompt; an empty answer is allowed. */
export const AnswerAction = actionRef<{ flowId: string; value: string }, null>('models', 'answer')
/** `{ flowId }` → null: cancel a running login flow. */
export const CancelAction = actionRef<{ flowId: string }, null>('models', 'cancel')
/** `{ provider }` → null: remove the provider's stored credential, which Pi shares. */
export const LogoutAction = actionRef<{ provider: string }, null>('models', 'logout')

/**
 * A `models.fallback` entry: the conversation's model (`provider/id`) had no login here, so its next run switched to
 * `to`: the same model on another provider, its definition's pin or the default model. Without `to` nothing could
 * replace it (or only a pay-per-token login could replace a subscription), so it kept its model and needs the user.
 */
export type Fallback = { from: string; to?: string; reason: 'same' | 'pin' | 'default' | 'none' }

/**
 * A login or logout of model provider `provider` completed through Ultimate; react to it to drop what you knew about
 * that provider's credentials (health resets its record to unknown).
 */
export const LoginChanged = defineEvent<{ provider: string }>('models.login-changed')
