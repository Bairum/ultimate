/** Claude Code in the browser: whether the local CLI is installed, logged in and on a subscription. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** The CLI's status metadata; never its output or the account's identity. */
export type ClaudeStatus = {
  available: boolean
  loggedIn: boolean
  subscription: boolean
  plan: string | null
}

/** No arguments → the CLI's status, after refreshing the model registry without network. */
export const StatusAction = actionRef<null, ClaudeStatus>('claude-code', 'status')
