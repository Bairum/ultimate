/** Setup in the browser: what isn't set up on this machine and what that costs. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** What fixes an issue: a command to run, or a secret to open in the Secrets panel. */
export type SetupFix = { label: string; command?: string; secret?: string }

/**
 * One area of the setup. `warn` costs the user something now; `info` is a choice worth knowing about; `ok` is set up.
 * `impact` says what the user loses, `fix` how to get it back.
 */
export type SetupIssue = {
  area: string
  status: 'ok' | 'warn' | 'info'
  /** One line: what is set up, or what is missing. */
  summary: string
  impact?: string
  fix?: SetupFix
}

/** No arguments → every area of this machine's setup, warnings first. */
export const CheckAction = actionRef<null, SetupIssue[]>('setup', 'check')
