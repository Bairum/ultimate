/**
 * Health: whether each model provider with a login on this machine works, from real calls and periodic pings, kept
 * in `~/.ultimate/health.json` and reported to the cloud.
 */
import type { ProviderHealth } from '../../cloud/protocol.ts'
import { defineApi } from '../../shared/extension-api.ts'

export interface HealthService {
  /** This machine's provider health, from `~/.ultimate/health.json`; use it before relying on a provider. */
  providers(): Promise<ProviderHealth[]>
  /** Ping `provider` now and record the result; false when it is not configured or the ping fails. */
  confirm(provider: string): Promise<boolean>
}
/** Provider health; `want` it, since health is optional. */
export const HealthApi = defineApi<HealthService>()('health')

/** What health reports to whoever listens: a provider that turned failing here. */
export interface HealthFeedbackService {
  /** `provider` turned failing (from ok or unknown) with a call or ping at `at`; called once per such turn. */
  failing(input: { provider: string; at: number; error?: string }): Promise<void>
}
/** Health's feedback point; sync provides it, health `want`s it. */
export const HealthFeedback = defineApi<HealthFeedbackService>()('health.feedback')
