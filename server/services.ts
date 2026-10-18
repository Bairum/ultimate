/**
 * A status row of the supervisor's terminal dashboard (`bin/dashboard.ts`), sent as a `services` core report. The core
 * no longer reports any: extension status lives in the catalogue and the extensions list.
 */
export type ServiceInfo = {
  state: 'starting' | 'ready' | 'busy' | 'error'
  detail?: string
  extension: string
  name: string
}
