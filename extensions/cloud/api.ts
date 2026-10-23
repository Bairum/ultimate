/** Cloud backups of the active chapter; optional because cloud ships disabled. */
import { defineApi } from '../../shared/extension-api.ts'
import type { LastBackup } from './types.ts'

export { BackupEvent } from './refs.ts'
export type { LastBackup } from './types.ts'
export type CloudService = {
  /** Back up the active chapter, without overriding a conflict. */
  backup(): Promise<LastBackup>
  /** Off when unconfigured; local when the project has no GitHub origin. */
  status(): Promise<'off' | 'local' | 'on'>
}
/** Optional chapter backup service; resolve with `want` at call time. */
export const CloudApi = defineApi<CloudService>()('cloud')
