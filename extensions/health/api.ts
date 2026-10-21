/**
 * Health: whether each model provider with a login on this machine works, from real calls and periodic pings, kept
 * in `~/.ultimate/health.json` and sent along with each cloud backup.
 */
import { defineApi } from '../../shared/extension-api.ts'
import type { ProviderHealth } from './refs.ts'

export type { ProviderHealth }

export interface HealthService {
  /** This machine's provider health, from `~/.ultimate/health.json`; use it before relying on a provider. */
  providers(): Promise<ProviderHealth[]>
  /** Ping `provider` now and record the result; false when it is not configured or the ping fails. */
  confirm(provider: string): Promise<boolean>
}
/** Provider health; `want` it, since health is optional. */
export const HealthApi = defineApi<HealthService>()('health')
