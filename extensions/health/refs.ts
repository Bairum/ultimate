/** Health in the browser: this machine's model provider health, which the status line warns about. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import { defineEvent } from '../../shared/events.ts'
import type { ProviderHealth } from '../../cloud/protocol.ts'

/** No arguments → `{ machine, providers }`: this machine's name and its providers' health; faux answers a demo. */
export const StateAction = actionRef<null, { machine: string; providers: ProviderHealth[] }>(
  'health',
  'state',
)
/**
 * Provider `provider`'s health on this machine changed to `state`; `error` is the sanitised reason of a failure. Only on
 * a change, never per call. Health lives in a file, so this commits on its own right after the write.
 */
export const Changed = defineEvent<{
  provider: string
  state: ProviderHealth['state']
  error?: string
}>('health.changed')
