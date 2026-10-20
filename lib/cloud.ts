/** The user's cloud sync settings: the replica to sync with and whether a starting machine claims a free lease. */
import { hostname } from 'node:os'
import { readSecret } from './secrets.ts'
import { readSettings, userSettingsPath } from './settings.ts'
import type { ExtensionHost } from '../server/extensions.ts'

/** `https://host` for the user's `wss://host/...` `cloud.url`. */
export function httpBase(url: string) {
  const endpoint = new URL(url)
  endpoint.protocol = endpoint.protocol === 'ws:' ? 'http:' : 'https:'
  return endpoint.origin
}

/** The user's `cloud` settings object; project settings are never read. */
async function userCloudSettings(host: Pick<ExtensionHost, 'userHome'>) {
  // Invalid user settings are reported by the settings loader; treat them as unset here.
  const settings = await readSettings(userSettingsPath(host.userHome)).catch(() => ({}))
  const cloud = 'cloud' in settings ? settings.cloud : undefined
  return cloud && typeof cloud === 'object' && !Array.isArray(cloud) ? cloud : {}
}

/** Only user settings may select a replica: a repository must not redirect the user's history. */
export async function cloudConfig(
  host: Pick<ExtensionHost, 'userHome' | 'faux' | 'notice'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string; token: string; machine: string } | undefined> {
  if (!env.ULTIMATE_CLOUD_URL && (host.faux || env.ULTIMATE_INSTANCE_OWNER)) return undefined
  const config = await userCloudSettings(host)
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

/** Whether a starting machine takes a free lease by itself (`cloud.autoClaim`, default true). */
export async function leaseSettings(
  host: Pick<ExtensionHost, 'userHome'>,
): Promise<{ autoClaim: boolean }> {
  const config = await userCloudSettings(host)
  return { autoClaim: config.autoClaim !== false }
}
