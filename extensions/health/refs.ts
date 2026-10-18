/** Health in the browser: this machine's model provider health, which the status line warns about. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import type { ProviderHealth } from '../../cloud/protocol.ts'

/** No arguments → `{ machine, providers }`: this machine's name and its providers' health; faux answers a demo. */
export const StateAction = actionRef<null, { machine: string; providers: ProviderHealth[] }>(
  'health',
  'state',
)
