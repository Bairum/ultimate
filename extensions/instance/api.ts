/** Standalone Ultimate instances for checking a scratch home, independent of conversation workspaces. */
import { defineApi } from '../../shared/extension-api.ts'

export type InstanceService = {
  /** Boot this host's project with a separate home; resolves when its API is ready. */
  start(options: { home: string }): Promise<{ id: string; url: string }>
  /** Stop the instance and its process group. Explicit homes remain the caller's responsibility. */
  stop(id: string): Promise<void>
}
/** Optional process-local instance service. */
export const InstanceApi = defineApi<InstanceService>()('instance')
