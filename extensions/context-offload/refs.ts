/** Context offload's browser-safe action contract. */
import { actionRef } from '../../shared/extension-api.ts'

/** User-only: `{ path }` → full UTF-8 output text, at most 4 MB; refuses paths outside project outputs. */
export const OpenAction = actionRef<{ path: string }, string>('context-offload', 'open')
