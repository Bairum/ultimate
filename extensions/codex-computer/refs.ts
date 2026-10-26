/** Codex computer: card data and the paired-browser Stop. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

export type UntrustedText = { text: string; untrusted: true }
export type CodexDetails = {
  status:
    | 'done'
    | 'failed'
    | 'budget'
    | 'stopped'
    | 'codex_missing'
    | 'codex_unsigned'
    | 'computer_use_missing'
    | 'declined'
  session?: string
  apps: {
    app: UntrustedText
    consent: 'accepted' | 'declined' | 'declined (unrecognised)' | 'timeout'
  }[]
  steps: { tool: UntrustedText; status: UntrustedText; at: number }[]
  approvals: { kind: string; app?: UntrustedText; decision: 'accept' | 'decline' | 'error' }[]
  screenshots: string[]
  answer: UntrustedText
  counts: { items: number; minutes: number }
  error?: string
}
export type CodexState = { last?: CodexDetails }
/** A conversation's last Codex outcome. Forks start fresh. */
export const StateDoc = docRef<CodexState>('codex-computer.state')
/** `{conversation?}` → `{stopped}`: stop matching runs, or all runs when omitted. User-only. */
export const StopAction = actionRef<{ conversation?: number }, { stopped: number }>(
  'codex-computer',
  'stop',
)
