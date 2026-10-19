/** Secrets: user-global secrets behind metadata-only actions; read values with lib/secrets.ts. Core tier. */
import { defineApi } from '../../shared/extension-api.ts'
import type { Written } from './refs.ts'

export type SecretsService = {
  /** Store `value` under `name` in the user's secrets file; returns metadata only. For flows the user drives. */
  set(name: string, value: string): Promise<Written>
}
/** Secret writes for another extension's user-only flow, such as sync's Join card; `need` it. */
export const SecretsApi = defineApi<SecretsService>()('secrets')
export const tier = 'core'
