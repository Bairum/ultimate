/** Codex computer: card data, durable consent and paired-browser controls. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

export type UntrustedText = { text: string; untrusted: true }
export type GrantScope = 'once' | 'conversation' | 'project'
export type CodexDetails = {
  status:
    | 'done'
    | 'failed'
    | 'budget'
    | 'stopped'
    | 'opt_in_required'
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
export type CodexState = {
  /** Used only on conversation 1: the project's explicit screen-sharing acknowledgement. */
  acknowledged: boolean
  grants: { app: string; scope: GrantScope | 'deny'; at: number }[]
  pending: {
    kind: 'acknowledge' | 'consent' | 'continue'
    /** Stable for consent and continuation entries; continuation ids deduplicate wake submissions. */
    id?: string
    app?: string
    session?: string
    at: number
  }[]
  last?: CodexDetails
}
/** Per-conversation consent/pending controls and last outcome; conversation 1 also holds project grants/acknowledgement. Forks start fresh. */
export const StateDoc = docRef<CodexState>('codex-computer.state')
/** `{conversation}` → state: acknowledge that screen content goes to OpenAI, for this project. User-only. */
export const AcknowledgeAction = actionRef<{ conversation: number }, CodexState>(
  'codex-computer',
  'acknowledge',
)
/** `{conversation, app, scope}` → state: case-insensitive app consent; once is consumed per elicitation. User-only. */
export const GrantAction = actionRef<
  { conversation: number; app: string; scope: GrantScope },
  CodexState
>('codex-computer', 'grant')
/** `{conversation, app}` → state: revoke local consent and decline waiting requests for this app. User-only. */
export const DenyAction = actionRef<{ conversation: number; app: string }, CodexState>(
  'codex-computer',
  'deny',
)
/** `{conversation}` → state: clear a pending budget continuation and wake that conversation. User-only. */
export const ContinueAction = actionRef<{ conversation: number }, CodexState>(
  'codex-computer',
  'continue',
)
/** `{conversation?}` → `{stopped}`: stop matching runs, or all runs when omitted. User-only. */
export const StopAction = actionRef<{ conversation?: number }, { stopped: number }>(
  'codex-computer',
  'stop',
)
