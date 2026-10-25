/** Watchdog: the failed runs it reported, newest first, for other extensions to summarize. */
import { defineApi } from '../../shared/extension-api.ts'
import type { Failure } from './refs.ts'

/** A reported failure and when its run failed (epoch ms). */
export type ReportedFailure = Failure & { at: number }

export interface WatchdogService {
  /** The last 20 reported failures whose run failed at or after `since` (epoch ms), newest first. */
  failures(since: number): Promise<ReportedFailure[]>
}
/** Reported failures; `want` it, since watchdog is optional. */
export const WatchdogApi = defineApi<WatchdogService>()('watchdog')
