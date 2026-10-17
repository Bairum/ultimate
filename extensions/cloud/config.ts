import { hostname } from 'node:os'
import { join } from 'node:path'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSettings } from '../onboarding/settings.ts'
import { readSecret } from '../secrets/store.ts'

/** Only user settings may select a replica: a repository must not redirect the user's history. */
export async function cloudConfig(
  host: Pick<ExtensionHost, 'userHome' | 'faux' | 'notice'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string; token: string; machine: string } | undefined> {
  if (!env.ULTIMATE_CLOUD_URL && (host.faux || env.ULTIMATE_INSTANCE_OWNER)) return undefined
  // Invalid user settings are reported by the settings loader; treat them as unset here.
  const settings = await readSettings(join(host.userHome, '.ultimate/settings.json')).catch(
    () => ({}),
  )
  const cloud = 'cloud' in settings ? settings.cloud : undefined
  const config = cloud && typeof cloud === 'object' && !Array.isArray(cloud) ? cloud : {}
  const url = env.ULTIMATE_CLOUD_URL ?? (typeof config.url === 'string' ? config.url : undefined)
  if (!url) return undefined
  const token =
    env.ULTIMATE_CLOUD_TOKEN ?? (await readSecret(host.userHome, 'ULTIMATE_CLOUD_TOKEN'))
  if (!token) {
    host.notice('Missing ULTIMATE_CLOUD_TOKEN. Add it in the Secrets panel (⌘K → Secrets).')
    return undefined
  }
  const machine =
    env.ULTIMATE_CLOUD_MACHINE ?? (typeof config.machine === 'string' ? config.machine : hostname())
  return { url, token, machine }
}
