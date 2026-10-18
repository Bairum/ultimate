import type { ExtensionHost } from '../../server/extensions.ts'
import { readHealth } from '../health/store.ts'
import type { ModelLogin } from './types.ts'

/**
 * The model login a move needs: the provider of the default model (`defaultProvider` in Pi's settings) must have
 * configured credentials (stored, runtime or from the environment). Without a default, the root conversation takes
 * the first available model, so any configured provider will do. It reads what the login panel shows and calls no
 * provider; a configured provider whose latest call on this machine failed (`~/.ultimate/health.json`) does not count,
 * with that call's error.
 */
export async function modelLogin(
  host: Pick<ExtensionHost, 'faux' | 'settings' | 'modelRuntime' | 'userHome'>,
): Promise<ModelLogin> {
  if (host.faux) return { provider: 'faux', ok: true }
  const chosen = host.settings.getDefaultProvider()
  const provider = chosen ?? (await host.modelRuntime.getAvailable())[0]?.provider
  if (!provider) return { provider: 'a model provider', ok: false }
  if (chosen && !host.modelRuntime.getProviderAuthStatus(chosen).configured)
    return { provider, ok: false }
  const health = (await readHealth(host.userHome)).find((entry) => entry.provider === provider)
  return health?.state === 'failing'
    ? { provider, ok: false, error: health.error ?? 'its last call failed' }
    : { provider, ok: true }
}

export const noLogin = (provider: string, error?: string) =>
  error
    ? `${provider} is failing here: ${error}; log in again with ⌘K → Log in`
    : `No model login: ${provider} is not configured here; log in with ⌘K → Log in`
