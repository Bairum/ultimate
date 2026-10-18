import type { ExtensionHost } from '../../server/extensions.ts'
import type { ModelLogin } from './types.ts'

/**
 * The model login a move needs: the provider of the default model (`defaultProvider` in Pi's settings) must have
 * configured credentials (stored, runtime or from the environment). Without a default, the root conversation takes
 * the first available model, so any configured provider will do. It reads what the login panel shows and calls no
 * provider: a stored credential the provider has since revoked still counts as configured.
 */
export async function modelLogin(
  host: Pick<ExtensionHost, 'faux' | 'settings' | 'modelRuntime'>,
): Promise<ModelLogin> {
  if (host.faux) return { provider: 'faux', ok: true }
  const provider = host.settings.getDefaultProvider()
  if (provider)
    return { provider, ok: host.modelRuntime.getProviderAuthStatus(provider).configured }
  const first = (await host.modelRuntime.getAvailable())[0]
  return first
    ? { provider: first.provider, ok: true }
    : { provider: 'a model provider', ok: false }
}

export const noLogin = (provider: string) =>
  `No model login: ${provider} is not configured here; log in with ⌘K → Log in`
