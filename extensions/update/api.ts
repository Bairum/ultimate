/** Update: whether the clone Ultimate runs from is behind origin, for other extensions to report. */
import { defineApi } from '../../shared/extension-api.ts'
import type { UpdateState } from './refs.ts'

export type { UpdateState }

export interface UpdateService {
  /** The clone's update state from the last check; never fetches origin. */
  state(): Promise<UpdateState>
}
/** The clone's update state; `want` it, since update is optional. */
export const UpdateApi = defineApi<UpdateService>()('update')
