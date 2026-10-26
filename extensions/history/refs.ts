/** History in the browser: the index's size. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** No arguments → indexed entries and conversations, and the index's bytes on disk (with its WAL). */
export const StatsAction = actionRef<
  null,
  { entries: number; conversations: number; bytes: number }
>('history', 'stats')
