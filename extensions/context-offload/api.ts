/** Context offload: durable tool text storage for recoverable request masking. */
import { defineApi } from '../../shared/extension-api.ts'

export type ContextOffloadService = {
  /** Save once per conversation/call id; return the absolute recovery path. Throws on failure. */
  save(conversation: number, callId: string, text: string): Promise<string>
}
/** Optional output store; consumers must keep original text if unavailable or saving fails. */
export const ContextOffload = defineApi<ContextOffloadService>()('context-offload')
