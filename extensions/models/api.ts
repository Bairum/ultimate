/** Models: the model and thinking pickers and provider logins in the composer. Core tier, no service. */
import { defineEvent } from '../../shared/events.ts'

/**
 * A login or logout of model provider `provider` completed through Ultimate; react to it to drop what you knew about
 * that provider's credentials (health resets its record to unknown).
 */
export const LoginChanged = defineEvent<{ provider: string }>('models.login-changed')
export const tier = 'core'
